import { anySignal } from '../shared/anySignal'
import { withBoundedOperation } from './boundedOperation'
import { isTransientFileReadError } from './fileDownloadRetry'

const CDN_IDLE_MS = 3_000
const ORIGIN_COOLDOWN_MS = 10 * 60_000
type ByteHop = { stage: 'cdn' | 'oss'; url: string }
const parsedUrl = (url: string) => {
  try { return new URL(url) } catch { throw new Error('Invalid file download URL') }
}

/** A network preference, never an authorization or a cache of signed capabilities. */
export function createFileDownloadSession() {
  const unavailable = new Map<string, number>()
  const advertised = new Map<string, { file: string; thumbnail?: string }>()
  const scopeKey = (url: string) => { const parsed = parsedUrl(url); return parsed.origin + parsed.pathname.replace(/\/+$/, '') }
  const cooling = (origin: string) => {
    const until = unavailable.get(origin)
    if (until === undefined) return false
    if (until > Date.now()) return true
    unavailable.delete(origin)
    return false
  }
  return {
    advertise(scope: string, url: string, thumbnail?: string | null) {
      const key = scopeKey(scope)
      advertised.set(key, { file: parsedUrl(url).origin,
        thumbnail: thumbnail ? parsedUrl(thumbnail).origin : advertised.get(key)?.thumbnail })
    },
    prefersOrigin(scope: string, variant: 'file' | 'thumbnail') {
      const routes = advertised.get(scopeKey(scope))
      return !!routes && cooling(variant === 'thumbnail' ? routes.thumbnail ?? routes.file : routes.file)
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
export function createFileDownloadTransport(target: () => ByteHop, fetcher: () => Promise<typeof fetch>,
  session: FileDownloadSession, signal?: AbortSignal) {
  let connection: AbortController | undefined
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
      return await (hop.stage === 'cdn' ? withBoundedOperation(CDN_IDLE_MS,
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
    read(reader: ReadableStreamDefaultReader<Uint8Array>) { return receive(() => reader.read(), target()) },
    refuse(error: Error): never { failed(target(), error); throw error },
    cancel(reader?: ReadableStreamDefaultReader<Uint8Array>) {
      connection?.abort(); connection = undefined
      // A broken stream's cancel promise must not hold the next authorized route hostage.
      void reader?.cancel().catch(() => undefined)
    },
  }
}
