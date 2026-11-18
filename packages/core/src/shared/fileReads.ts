import { FileIntegrityError } from './fileCipher'
import { createFileResolver, FileReadError, FileReadRevokedError, MissingFileObjectError, type FileActor, type FileBytes, type FileContext, type FileHandle, type FileRef, type FileRevision, type FileProviders } from './fileResolver'

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
export interface FileReadHooks {
  waitDeclared: boolean
  waits: ReturnType<typeof createSenderWaits>
  state(state: FileReadState): void
  reuse(value: FileReadReuse): void
  acquire(backend: string, route: FileReadRoute, revision: FileRevision, context: FileContext, open: Transfer): Promise<FileBytes>
}

function readFailure(error: unknown, signal?: AbortSignal): FileReadError {
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
  route: FileReadRoute
  controller: AbortController
  subscribers: Set<Subscriber>
  bytes: Promise<FileBytes>
  reuse: FileReadReuse
  progress?: [number, number]
}

/** One host owns the flights. Each participant arrives after its own route and authorization checks. */
export function createFileReads(providers: FileProviders, store: FileReadStore = {}): FileReads {
  const waits = createSenderWaits()
  const flights = new Map<string, Flight>()
  const acquire: FileReadHooks['acquire'] = async (backend, route, revision, context, open) => {
    context.signal?.throwIfAborted()
    context.reads?.state({ status: 'transferring', route })
    if (revision.sha256 === null) return open(context)
    // Device-only reads must never acquire a transfer through the cloud.
    const deviceOnly = revision.source === 'local' && !revision.temporary_transfer
    const key = JSON.stringify([backend, context.actor.accountId, revision.sha256, revision.size_bytes, deviceOnly])
    let flight = flights.get(key)
    if (!flight) {
      const subscribers = new Set<Subscriber>(), controller = new AbortController()
      const reuse = (value: FileReadReuse) => {
        current.reuse = value
        for (const { hooks } of subscribers) hooks?.reuse(value)
      }
      const transfer = { ...context, signal: controller.signal,
        reads: context.reads && { ...context.reads, reuse },
        progress: (done: number, total: number) => {
          current.progress = [done, total]
          for (const row of subscribers) row.progress?.(done, total)
        },
      }
      const bytes = Promise.resolve().then(async () => {
        const cached = await store.cachedCopy?.(backend, revision, transfer)
        if (cached) { reuse('verified-local'); return cached }
        controller.signal.throwIfAborted()
        return open(transfer)
      })
      const current: Flight = { route, bytes, controller, subscribers, reuse: null }
      flights.set(key, current)
      flight = current
    }
    const joined = flight
    const row = { hooks: context.reads, progress: context.progress }
    joined.subscribers.add(row)
    if (joined.route !== route) row.hooks?.state({ status: 'transferring', route: joined.route })
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
        resolve({ size: file.size, read: (offset, length) => file.read(offset, length), dispose: release })
      }, error => {
        context.signal?.removeEventListener('abort', abort)
        void release().then(() => reject(error), reject)
      })
    })
  }
  const noop = () => {}
  const hooks = (): FileReadHooks => ({ waits, acquire, waitDeclared: false, state: noop, reuse: noop })
  return {
    resolve: createFileResolver(providers, hooks),
    nudge: waits.nudge,
    request(ref, actor, { purpose, signal }) {
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
        reuse(value) {
          reused = value
          if (value === 'verified-local') emit({ status: 'transferring', route: 'local' })
        },
      }))
      const result = (async () => {
        let file: FileHandle | undefined
        try {
          const resolved = await resolve(ref, actor, { signal, showFirst: purpose === 'show' ? true : undefined,
            progress: (done, total) => emit({ status: 'transferring', route, done, total }) })
          if (resolved.status !== 'ready') {
            if (resolved.status === 'missing') throw new MissingFileObjectError()
            throw new FileReadError(resolved.status === 'failed' || resolved.status === 'pending' ? 'upload_failed' : resolved.status, resolved.status)
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
