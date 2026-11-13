import { BODY_CHUNK_BYTES, type SessionpageSessionBodyReadRequest, type SessionpageSessionBodyReadResult, type WindowBodyRef } from '@gugu/session-core/session-record/contract'

type BodyPage = Extract<SessionpageSessionBodyReadResult, { kind: 'body' }>
export type BodyPageView = { phase: 'idle' | 'loading' | 'body' | 'needs_location' | 'reset' | 'error'; page?: BodyPage; error?: string }
type Read = (input: SessionpageSessionBodyReadRequest, signal: AbortSignal) => Promise<SessionpageSessionBodyReadResult>
const identity = (ref: WindowBodyRef) => JSON.stringify([ref.scope, ref.sourceLineage, ref.id, ref.revision, ref.owner])
const offsetOk = (offset: number) => Number.isSafeInteger(offset) && offset >= 0

/** A viewport cache, never a collector of every body page or page boundary. */
export class TimelineBodyWindow {
  private cache = new Map<string, BodyPage>()
  private generation = 0
  private controller: AbortController | null = null
  private refKey: string | null = null
  private pending: { key: string; promise: Promise<BodyPageView | null> } | null = null
  private listeners = new Set<() => void>()
  view: BodyPageView = { phase: 'idle' }
  constructor(private conversationId: string, private read: Read) {}
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  snapshot = () => this.view
  private publish(view: BodyPageView) { this.view = view; for (const listener of this.listeners) listener() }

  invalidate() {
    this.generation++ // Invalidate before abort: an uncancellable IPC reply can never commit.
    this.controller?.abort()
    this.controller = null
    this.pending = null
    this.cache.clear()
    this.refKey = null
    this.publish({ phase: 'idle' })
  }
  dispose() { this.invalidate(); this.listeners.clear() }

  next(ref: WindowBodyRef) {
    const page = this.refKey === identity(ref) ? this.view.page : undefined
    return page && page.moreAfter !== 'no' ? this.load(ref, page.nextOffset) : Promise.resolve(null)
  }
  previous(ref: WindowBodyRef) {
    const page = this.refKey === identity(ref) ? this.view.page : undefined
    return page && page.previousOffset !== null
      ? this.load(ref, page.previousOffset, page.offset - page.previousOffset, page.offset) : Promise.resolve(null)
  }

  load(ref: WindowBodyRef, offset = 0, maxBytes = BODY_CHUNK_BYTES, exactEnd?: number): Promise<BodyPageView | null> {
    if (!offsetOk(offset) || !Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > BODY_CHUNK_BYTES) return Promise.reject(new Error('Invalid decoded body range'))
    const refKey = identity(ref)
    const key = JSON.stringify([refKey, offset, maxBytes])
    const pendingKey = JSON.stringify([key, exactEnd])
    if (this.pending?.key === pendingKey) return this.pending.promise
    if (this.refKey !== refKey) this.invalidate()
    const generation = ++this.generation
    this.controller?.abort()
    const controller = new AbortController()
    this.controller = controller
    this.refKey = refKey
    const cached = this.cache.get(key)
    if (cached && (exactEnd === undefined || cached.nextOffset === exactEnd)) {
      this.cache.delete(key); this.cache.set(key, cached)
      this.publish({ phase: 'body', page: cached })
      return Promise.resolve(this.view)
    }
    this.publish({ phase: 'loading', page: this.view.page })
    const promise = (async (): Promise<BodyPageView | null> => {
      try {
        const page = await this.read({ conversationId: this.conversationId, bodyRef: ref, offset, maxBytes }, controller.signal)
        if (generation !== this.generation || controller.signal.aborted) return null
        if (page.bodyId !== ref.id || page.revision !== ref.revision) throw new Error('Body identity changed')
        if (page.kind === 'body') {
          // Check cheap scalar/string limits before allocating an encoded copy.
          if (page.offset !== offset || page.text.length > maxBytes) throw new Error('Invalid body page')
          const bytes = new TextEncoder().encode(page.text).byteLength
          if (bytes > maxBytes || page.nextOffset !== offset + bytes || !offsetOk(page.nextOffset)
            || (exactEnd !== undefined && page.nextOffset !== exactEnd)
            || (page.moreAfter !== 'no' && bytes === 0)
            || (offset === 0 ? page.previousOffset !== null : !offsetOk(page.previousOffset!) || page.previousOffset! >= offset)) throw new Error('Invalid decoded body boundaries')
          for (const char of page.text) { const code = char.codePointAt(0)!; if (code >= 0xd800 && code <= 0xdfff) throw new Error('Incomplete Unicode character') }
          this.cache.set(key, page)
          while (this.cache.size > 4) this.cache.delete(this.cache.keys().next().value!)
          this.publish({ phase: 'body', page })
        } else {
          this.cache.clear()
          this.publish({ phase: page.kind })
        }
      } catch (error) {
        if (generation !== this.generation || controller.signal.aborted) return null
        this.publish({ phase: 'error', page: this.view.page, error: error instanceof Error ? error.message : String(error) })
      }
      return this.view
    })()
    this.pending = { key: pendingKey, promise }
    void promise.finally(() => { if (this.pending?.promise === promise) this.pending = null })
    return promise
  }
}
