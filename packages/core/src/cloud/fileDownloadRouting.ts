import { anySignal } from '../shared/anySignal'
import { withBoundedOperation } from './boundedOperation'
import { isTransientFileReadError } from './fileDownloadRetry'

const CDN_IDLE_MS = 3_000
const ORIGIN_COOLDOWN_MS = 10 * 60_000
type ByteHop = { stage: 'cdn' | 'oss'; url: string }
const parsedUrl = (url: string) => {
  try { return new URL(url) } catch { throw new Error('Invalid file download URL') }
}

/** A network preference, never an authorization or a cache of signed capabilities. `cdnIdleMs` bounds each CDN wait. */
export function createFileDownloadSession({ cdnIdleMs = CDN_IDLE_MS }: { cdnIdleMs?: number } = {}) {
  const unavailable = new Map<string, number>()
  const advertised = new Map<string, string>()
  const scopeKey = (url: string) => { const parsed = parsedUrl(url); return parsed.origin + parsed.pathname.replace(/\/+$/, '') }
  const cooling = (origin: string) => {
    const until = unavailable.get(origin)
    if (until === undefined) return false
    if (until > Date.now()) return true
    unavailable.delete(origin)
    return false
  }
  return {
    cdnIdleMs,
    advertise(scope: string, url: string) { advertised.set(scopeKey(scope), parsedUrl(url).origin) },
    prefersOrigin(scope: string) {
      const route = advertised.get(scopeKey(scope))
      return !!route && cooling(route)
    },
    failed(url: string, error: unknown) {
      if (isTransientFileReadError(error)) unavailable.set(parsedUrl(url).origin, Date.now() + ORIGIN_COOLDOWN_MS)
    },
  }
}
export type FileDownloadSession = ReturnType<typeof createFileDownloadSession>
// Shared by providers in this JS runtime; restarting the client forgets the preference.
export const fileDownloadSession = createFileDownloadSession()

/** Deadline each CDN network wait, not an actively progressing transfer's total duration. */
export function createFileDownloadTransport(target: () => ByteHop, fetcher: () => Promise<typeof globalThis.fetch>,
  session: FileDownloadSession, signal?: AbortSignal) {
  let connection: AbortController | undefined, reading: AbortController | undefined, idle: ReturnType<typeof setTimeout> | undefined
  // Settles (rejects) once, when the connection is aborted or the read is: one promise per connection, not per read.
  const stopped = new WeakMap<AbortController, Promise<never>>()
  const stoppedOf = (active: AbortController) => {
    let ending = stopped.get(active)
    if (!ending) {
      ending = new Promise<never>((_, reject) => {
        const end = () => reject(active.signal.aborted ? active.signal.reason : signal?.reason)
        active.signal.addEventListener('abort', end, { once: true }); signal?.addEventListener('abort', end, { once: true })
        if (active.signal.aborted || signal?.aborted) end()
      })
      ending.catch(() => undefined)
      stopped.set(active, ending)
    }
    return ending
  }
  const failed = (hop: ByteHop, error: unknown) => {
    if (hop.stage === 'cdn' && !signal?.aborted) session.failed(hop.url, error)
  }
  async function receive<T>(operation: () => Promise<T>, hop: ByteHop, active = connection): Promise<T> {
    signal?.throwIfAborted()
    let detachDeadline: (() => void) | undefined, detachAbort: (() => void) | undefined
    const run = () => {
      const work = Promise.resolve().then(() => { signal?.throwIfAborted(); active?.signal.throwIfAborted(); return operation() })
      if (!signal) return work
      return Promise.race([work, new Promise<never>((_, reject) => {
        const aborted = () => reject(signal.reason)
        signal.addEventListener('abort', aborted, { once: true })
        detachAbort = () => signal.removeEventListener('abort', aborted)
        if (signal.aborted) aborted()
      })])
    }
    try {
      return await (hop.stage === 'cdn' ? withBoundedOperation(session.cdnIdleMs,
        () => Object.assign(new Error('CDN byte read timed out'), { code: 'ETIMEDOUT' }), deadline => {
          const abort = () => active?.abort(deadline.reason)
          deadline.addEventListener('abort', abort, { once: true })
          detachDeadline = () => deadline.removeEventListener('abort', abort)
          return run()
        }) : run())
    } catch (error) { failed(hop, error); throw error }
    finally { detachDeadline?.(); detachAbort?.() }
  }
  return {
    async open(init?: RequestInit) {
      // Resolving the authenticated transport is not a CDN health probe.
      const fetch = await fetcher()
      signal?.throwIfAborted()
      const hop = target(), active = new AbortController()
      connection?.abort(); connection = active
      return receive(async () => {
        const response = await fetch(hop.url, { ...init, signal: anySignal([signal, active.signal]) })
        if (active.signal.aborted || signal?.aborted) {
          void response.body?.cancel().catch(() => undefined)
          signal?.throwIfAborted(); active.signal.throwIfAborted()
        }
        return response
      }, hop, active)
    },
    /**
     * A body read: the connection's own signal (the reader's abort, a route switch) already ends it, so the only bound to
     * add is the CDN idle deadline, one timer set again per read. A store gives a large body in thousands of small reads;
     * a deadline built per read (its error, controller and races) halved what three lanes carried.
     */
    async read(reader: ReadableStreamDefaultReader<Uint8Array>) {
      signal?.throwIfAborted()
      const hop = target(), active = connection
      if (hop.stage === 'cdn' && active) {
        reading = active
        clearTimeout(idle)
        idle = setTimeout(() => {
          const stalled = reading
          if (!stalled) return
          reading = undefined
          stalled.abort(Object.assign(new Error('CDN byte read timed out'), { code: 'ETIMEDOUT' }))
        }, CDN_IDLE_MS)
      }
      try {
        active?.signal.throwIfAborted()
        // A body that does not end when its connection is aborted still ends this read.
        return await (active ? Promise.race([reader.read(), stoppedOf(active)]) : reader.read())
      } catch (error) {
        const reason = active?.signal.aborted ? active.signal.reason : signal?.aborted ? signal.reason : error
        failed(hop, reason); throw reason
      } finally { if (reading === active) { reading = undefined; clearTimeout(idle) } }
    },
    refuse(error: Error): never { failed(target(), error); throw error },
    cancel(reader?: ReadableStreamDefaultReader<Uint8Array>) {
      connection?.abort(); connection = undefined; reading = undefined
      if (idle) { clearTimeout(idle); idle = undefined }
      // A broken stream's cancel promise must not hold the next authorized route hostage.
      void reader?.cancel().catch(() => undefined)
    },
  }
}
