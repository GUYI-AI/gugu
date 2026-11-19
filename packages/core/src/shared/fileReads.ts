import { coreLogger } from '../log'
import { FileIntegrityError } from './fileCipher'
import { createFileResolver, FileReadError, FileReadRevokedError, MissingFileObjectError, type FileActor, type FileBytes, type FileContext, type FileHandle, type FileMetadata, type FileRef, type FileRevision, type FileProviders } from './fileResolver'

const log = coreLogger('file-reads')

export type FileReadRoute = 'local' | 'ssh' | 'oss'
export type FileReadReuse = 'verified-local' | 'chunks' | null
export type FileReadFailure = 'holder_offline' | 'transfer_disabled' | 'upload_failed' | 'expired' | 'gone'
  | 'access_revoked' | 'integrity_failed' | 'interrupted' | 'cancelled'
export type FileReadState =
  | { status: 'waiting_sender'; reason: 'declared' | 'relay'; holder?: { label?: string; online?: boolean } }
  | { status: 'transferring'; route: FileReadRoute; done?: number; total?: number }
  | { status: 'verifying' }
  | { status: 'done'; route: FileReadRoute; reused: FileReadReuse; sha256: string | null }
  | { status: 'failed'; code: FileReadFailure; message: string }

export interface FileReadOptions {
  purpose: 'save' | 'bytes' | 'show'
  signal?: AbortSignal
  /** The message's metadata for this file: a managed object it must fetch is then admitted by its own signed download. */
  admit?: FileMetadata
}
export interface FileReadResult {
  /** Caller owns this pinned handle. Use its existing stream, saveTo, acknowledgement and dispose contracts. */
  file: FileHandle
  route: FileReadRoute
  reused: FileReadReuse
  sha256: string | null
  waited_ms: number
}
export interface FileReadRequest {
  /** Subscribing replays the latest state. The return value unsubscribes. */
  state$(listener: (state: FileReadState) => void): () => void
  result: Promise<FileReadResult>
}
export interface FileReads {
  request(ref: FileRef, actor: FileActor, options: FileReadOptions): FileReadRequest
  /** Compatible lazy metadata, preview, localOnly and FileHandle API. */
  resolve: ReturnType<typeof createFileResolver>
  nudge(): void
}
export interface FileReadStore {
  /** A verified original for this backend and account only. A hit still requires this request's read confirmation. */
  cachedCopy?(backend: string, revision: FileRevision, context: FileContext): Promise<FileBytes | null>
}

type Waiting = Extract<FileReadState, { status: 'waiting_sender' }>

export function createSenderWaits() {
  const wake = new Set<() => void>()
  let generation = 0
  return {
    nudge() { generation++; for (const run of [...wake]) run() },
    async until<T>(check: () => Promise<T>, pending: (value: T) => Waiting | undefined, signal?: AbortSignal, report?: (state: Waiting) => void): Promise<T> {
      let delay = 700
      for (;;) {
        signal?.throwIfAborted()
        const before = generation, value = await check()
        signal?.throwIfAborted()
        const state = pending(value)
        if (!state) return value
        report?.(state)
        if (generation !== before) continue
        await new Promise<void>((resolve) => {
          const resume = () => { clearTimeout(timer); wake.delete(resume); signal?.removeEventListener('abort', resume); resolve() }
          const timer = setTimeout(resume, delay)
          wake.add(resume)
          signal?.addEventListener('abort', resume, { once: true })
          if (signal?.aborted) resume()
        })
        delay = Math.min(delay * 2, 10_000)
      }
    },
  }
}

export { FileReadError } from './fileResolver'

type Transfer = (context: FileContext) => Promise<FileBytes>
type RelayScope = { reader: string } | { generation: string; verifiedHere: boolean }
export interface FileReadHooks {
  waitDeclared: boolean
  waits: ReturnType<typeof createSenderWaits>
  state(state: FileReadState): void
  reuse(value: FileReadReuse): void
  acquire(backend: string, route: FileReadRoute, revision: FileRevision, context: FileContext, open: Transfer, relay?: RelayScope): Promise<FileBytes>
  /** A verified local copy of this managed revision, or a running fetch of it that a new request would join. */
  served(backend: string, revision: FileRevision, context: FileContext): Promise<boolean>
}

/** A read's failure in the reader's terms (§2.8), whichever layer raised it. */
export function readFailure(error: unknown, signal?: AbortSignal): FileReadError {
  const message = error instanceof Error ? error.message : String(error)
  if (signal?.aborted) return new FileReadError('cancelled', message, error)
  if (error instanceof FileIntegrityError) return new FileReadError('integrity_failed', message, error)
  if (error instanceof FileReadError) return error
  if (error instanceof FileReadRevokedError) return new FileReadError(error.reason === 'expired' || error.reason === 'gone' ? error.reason : 'access_revoked', message, error)
  if (error instanceof MissingFileObjectError) return new FileReadError('gone', message, error)
  const { code, status } = (error ?? {}) as { code?: string; status?: number }
  if (status === 401 || status === 403 || status === 404) return new FileReadError('access_revoked', message, error)
  if (code === 'transfer_disabled' || code === 'expired') return new FileReadError(code, message, error)
  return new FileReadError('interrupted', message, error)
}

type Subscriber = { progress?: FileContext['progress']; hooks?: FileReadHooks }
type Flight = {
  state?: FileReadState
  controller: AbortController
  subscribers: Set<Subscriber>
  bytes: Promise<FileBytes>
  reuse: FileReadReuse
  progress?: [number, number]
}

const flightKey = (backend: string, account: string, revision: FileRevision, deviceOnly: boolean, scope: unknown) =>
  JSON.stringify([backend, account, revision.sha256, revision.size_bytes, deviceOnly, scope])

/** One host owns the flights. Each participant arrives after its own route and authorization checks. */
export function createFileReads(providers: FileProviders, store: FileReadStore = {}): FileReads {
  const waits = createSenderWaits()
  const flights = new Map<string, Flight>()
  const acquire: FileReadHooks['acquire'] = async (backend, route, revision, context, open, relay) => {
    context.signal?.throwIfAborted()
    const report = (actualRoute: FileReadRoute, reused: FileReadReuse) => {
      log.info({ route: actualRoute, reused, size_bytes: revision.size_bytes, sha256: revision.sha256,
        ...(actualRoute === 'oss' ? { oss_source: revision.source === 'managed-object' ? 'object' : 'relay' } : {}) }, 'file snapshot acquired')
    }
    if (revision.sha256 === null) {
      context.reads?.state({ status: 'transferring', route })
      const bytes = await open(context)
      report(route, null)
      return bytes
    }
    // Device-only reads must never acquire a transfer through the cloud.
    const deviceOnly = revision.source === 'local' && !revision.temporary_transfer
    const readerScope = relay && 'reader' in relay
    const scope = readerScope ? ['reader', relay.reader] : relay && ['generation', relay.generation]
    const key = flightKey(backend, context.actor.accountId, revision, deviceOnly, scope)
    let flight = flights.get(key)
    if (!flight) {
      const subscribers = new Set<Subscriber>(), controller = new AbortController()
      const reuse = (value: FileReadReuse) => {
        current.reuse = value
        for (const { hooks } of subscribers) hooks?.reuse(value)
      }
      const state = (value: FileReadState) => {
        current.state = value
        for (const { hooks } of subscribers) hooks?.state(value)
      }
      const transfer = { ...context, signal: controller.signal,
        reads: context.reads && { ...context.reads, reuse, state },
        progress: (done: number, total: number) => {
          current.progress = [done, total]
          for (const row of subscribers) row.progress?.(done, total)
        },
      }
      const bytes = Promise.resolve().then(async () => {
        if (readerScope) return open(transfer)
        const cached = (!relay || relay.verifiedHere) && await store.cachedCopy?.(backend, revision, transfer)
        if (cached) { state({ status: 'transferring', route: 'local' }); reuse('verified-local'); report('local', 'verified-local'); return cached }
        controller.signal.throwIfAborted()
        state({ status: 'transferring', route })
        const file = await open(transfer)
        report(route, current.reuse)
        return file
      })
      const current: Flight = { bytes, controller, subscribers, reuse: null }
      flights.set(key, current)
      if (readerScope) {
        // A consumed one-time grant cannot be reused, even while a caller still holds its opened handle.
        const retire = () => { if (flights.get(key) === current) flights.delete(key) }
        void bytes.then(file => file.acknowledged).then(retire, retire)
      }
      flight = current
    }
    const joined = flight
    const row = { hooks: context.reads, progress: context.progress }
    joined.subscribers.add(row)
    if (joined.state) row.hooks?.state(joined.state)
    if (joined.reuse) row.hooks?.reuse(joined.reuse)
    if (joined.progress) row.progress?.(...joined.progress)
    const release = async () => {
      if (!joined.subscribers.delete(row) || joined.subscribers.size) return
      if (flights.get(key) === joined) flights.delete(key)
      joined.controller.abort()
      await joined.bytes.then(file => file.dispose(), () => {})
    }
    // The transfer keeps its own signal. An impatient reader only drops its own reference.
    return new Promise<FileBytes>((resolve, reject) => {
      const abort = () => { void release().catch(reject); reject(context.signal?.reason) }
      context.signal?.addEventListener('abort', abort, { once: true })
      joined.bytes.then(file => {
        context.signal?.removeEventListener('abort', abort)
        if (context.signal?.aborted) { abort(); return }
        resolve({ size: file.size, read: (offset, length) => file.read(offset, length), dispose: release, saved: file.saved?.bind(file),
          acknowledged: readerScope ? file.acknowledged : undefined })
      }, error => {
        context.signal?.removeEventListener('abort', abort)
        void release().then(() => reject(error), reject)
      })
    })
  }
  const noop = () => {}
  const served: FileReadHooks['served'] = async (backend, revision, context) => {
    if (flights.has(flightKey(backend, context.actor.accountId, revision, false, undefined))) return true
    const cached = await store.cachedCopy?.(backend, revision, context)
    if (!cached) return false
    await cached.dispose()
    return true
  }
  const hooks = (): FileReadHooks => ({ waits, acquire, served, waitDeclared: false, state: noop, reuse: noop })
  return {
    resolve: createFileResolver(providers, hooks),
    nudge: waits.nudge,
    request(ref, actor, { purpose, signal, admit }) {
      const listeners = new Set<(state: FileReadState) => void>()
      let latest: FileReadState | undefined, route: FileReadRoute = 'oss', reused: FileReadReuse = null
      let waited = 0, since: number | undefined
      const emit = (state: FileReadState) => {
        if (state.status === 'waiting_sender') since ??= Date.now()
        else if (since !== undefined) { waited += Date.now() - since; since = undefined }
        if (state.status === 'transferring') route = state.route
        latest = state
        for (const listener of listeners) listener(state)
      }
      const resolve = createFileResolver(providers, () => ({ ...hooks(), waitDeclared: true, state: emit,
        reuse(value) { reused = value },
      }))
      const result = (async () => {
        let file: FileHandle | undefined
        try {
          const resolved = await resolve(ref, actor, { signal, ...(admit ? { admit } : {}), showFirst: purpose === 'show' ? true : undefined,
            progress: (done, total) => emit({ status: 'transferring', route, done, total }) })
          if (resolved.status !== 'ready') {
            if (resolved.status === 'missing') throw new MissingFileObjectError()
            if (resolved.status === 'failed' || resolved.status === 'pending') throw new FileReadError('upload_failed', "The sender's upload did not complete. Ask them to send the file again.")
            throw new FileReadError(resolved.status, resolved.status === 'expired' ? 'This file expired. Ask the sender to upload it again.' : 'This file was deleted or you no longer have access to it.')
          }
          file = resolved
          await file.open!()
          signal?.throwIfAborted()
          const sha256 = file.revision.sha256
          const done = () => emit({ status: 'done', route, reused, sha256 })
          if (purpose === 'show') void file.acknowledgement!().then(done, error => {
            const failure = readFailure(error, signal)
            emit({ status: 'failed', code: failure.code, message: failure.message })
          })
          else done()
          return { file, route, reused, sha256, waited_ms: waited }
        } catch (error) {
          await file?.dispose()
          const failure = readFailure(error, signal)
          emit({ status: 'failed', code: failure.code, message: failure.message })
          throw failure
        }
      })()
      return { result, state$(listener) { listeners.add(listener); if (latest) listener(latest); return () => { listeners.delete(listener) } } }
    },
  }
}
