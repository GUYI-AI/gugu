import { VaultError, type VaultDependencies, type VaultFeatureGuard } from './contracts'

/** One operation's live qualification, not approval or a second vault lock state. */
export class VaultFeatureOperation {
  readonly #abort = new AbortController()
  readonly #detach: (() => void)[] = []
  #check?: () => unknown
  #closed = false
  #writeStarted = false
  get writeStarted(): boolean { return this.#writeStarted }
  get signal(): AbortSignal { return this.#abort.signal }
  private link(signal: AbortSignal): void {
    if (!(signal instanceof AbortSignal)) throw new VaultError('UNAVAILABLE')
    const stop = () => this.release()
    signal.addEventListener('abort', stop, { once: true }); this.#detach.push(() => signal.removeEventListener('abort', stop))
    if (signal.aborted) stop()
  }
  static async acquire(provider: VaultDependencies['acquireFeatureGuard'], operation: 'save' | 'use', parent: AbortSignal): Promise<VaultFeatureOperation> {
    const value = new VaultFeatureOperation()
    try {
      if (!provider) throw new VaultError('UNAVAILABLE')
      value.link(parent)
      if (value.signal.aborted) throw new VaultError('UNAVAILABLE')
      const guard = await new Promise<VaultFeatureGuard>((resolve, reject) => {
        const stop = () => reject(new VaultError('UNAVAILABLE'))
        value.signal.addEventListener('abort', stop, { once: true })
        Promise.resolve().then(() => {
          if (value.signal.aborted) throw new VaultError('UNAVAILABLE')
          return provider(operation, value.signal)
        }).then(resolve, reject).finally(() => value.signal.removeEventListener('abort', stop))
      })
      if (guard?.status !== 'ready' || typeof guard.assertCurrent !== 'function') throw new VaultError('UNAVAILABLE')
      value.#check = guard.assertCurrent.bind(guard); value.link(guard.signal); value.assertCurrent()
      return value
    } catch { value.release(); throw new VaultError('UNAVAILABLE') }
  }
  readonly assertCurrent = (): void => {
    try {
      if (this.#closed || this.signal.aborted || !this.#check) throw new VaultError('UNAVAILABLE')
      const result = this.#check()
      if (result !== undefined) { void Promise.resolve(result).catch(() => undefined); throw new VaultError('UNAVAILABLE') }
      if (this.signal.aborted) throw new VaultError('UNAVAILABLE')
    } catch { this.release(); throw new VaultError('UNAVAILABLE') }
  }
  beforeWrite(): void { this.assertCurrent(); this.#writeStarted = true }
  async wait<T>(action: () => Promise<T>): Promise<T> {
    this.assertCurrent(); const value = await action(); this.assertCurrent(); return value
  }
  onInvalidate(clear: () => void): () => void {
    this.signal.addEventListener('abort', clear, { once: true })
    if (this.signal.aborted) clear()
    return () => this.signal.removeEventListener('abort', clear)
  }
  release(): void {
    this.#closed = true; this.#check = undefined; this.#abort.abort(); for (const detach of this.#detach.splice(0)) detach()
  }
}
