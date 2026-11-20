export type PushScope = { ownerId: string; sessionId: string }
export type PushBinding = { ownerId: string; installationId: string; deviceId: string; provider: string | null; topic: string; environment: string; allowed: boolean }
export type PushReceipt = { registration_id: string; generation: string }
export type PushPreferences = { chatMessages: boolean; chatSound: boolean; taskEnabled: boolean; taskSound: boolean }
export interface AndroidPushDeps {
  restore?(scope: PushScope, binding: PushBinding): PushReceipt | null
  status(scope: PushScope): Promise<PushBinding>
  register(scope: PushScope): Promise<PushBinding & { token: string }>
  save(scope: PushScope, binding: PushBinding & { token: string }, prefs: PushPreferences): Promise<PushReceipt>
  revoke(scope: PushScope, binding: PushBinding, receipt: PushReceipt): Promise<boolean>
  close(scope: PushScope, binding: PushBinding): Promise<void>
  revokeNative(scope: PushScope): Promise<void>
  authority(confirmed: boolean): void
}
export const samePushScope = (a: PushScope | null, b: PushScope | null): boolean =>
  a !== null && b !== null && a.ownerId === b.ownerId && a.sessionId === b.sessionId

/** Serialize registration and retirement; late registration must drain before logout. */
export class AndroidPushSync {
  private epoch = 0
  private tail: Promise<void> = Promise.resolve()
  private current: PushScope | null = null
  private blocked: PushScope | null = null
  private receipt: { scope: PushScope; binding: PushBinding; value: PushReceipt } | null = null
  constructor(private readonly deps: AndroidPushDeps) {}
  synchronize(scope: PushScope | null, prefs: PushPreferences): Promise<void> {
    const sameLogin = samePushScope(scope, this.current)
    this.current = scope
    const epoch = ++this.epoch
    if (!sameLogin) this.deps.authority(false)
    if (!scope || samePushScope(scope, this.blocked)) return this.tail
    const valid = () => this.epoch === epoch && samePushScope(scope, this.current) && !samePushScope(scope, this.blocked)
    const run = this.tail.catch(() => undefined).then(async () => {
      if (!valid()) return
      const status = await this.deps.status(scope)
      if (!valid()) return
      if (!this.receipt || !samePushScope(scope, this.receipt.scope)) {
        const restored = this.deps.restore?.(scope, status)
        if (restored) this.receipt = { scope, binding: status, value: restored }
      }
      if (!status.allowed || !status.provider || (!prefs.chatMessages && !prefs.taskEnabled)) {
        this.deps.authority(false)
        if (this.receipt && samePushScope(scope, this.receipt.scope)) {
          if (!await this.deps.revoke(scope, this.receipt.binding, this.receipt.value)) throw new Error('Push revocation was not confirmed')
          this.receipt = null
        }
        if (status.provider) await this.deps.revokeNative(scope)
        return
      }
      const binding = await this.deps.register(scope)
      if (!valid()) return
      const receipt = await this.deps.save(scope, binding, prefs)
      // Retain even a late acknowledgement, so queued retirement can revoke it.
      this.receipt = { scope, binding, value: receipt }
      if (valid()) this.deps.authority(true)
    })
    this.tail = run
    return run
  }
  async retire(scope: PushScope): Promise<void> {
    this.blocked = scope; ++this.epoch; this.deps.authority(false)
    const run = this.tail.catch(() => undefined).then(async () => {
      const binding = await this.deps.status(scope)
      // Durable close covers cold starts and lost registration acknowledgements.
      await this.deps.close(scope, binding)
      await this.deps.revokeNative(scope)
      this.receipt = null
    })
    this.tail = run
    return run
  }
  withdraw(): void { ++this.epoch; this.current = null; this.deps.authority(false) }
  bindingForTap(scope: PushScope): { binding: PushBinding; value: PushReceipt } | null {
    return this.receipt && samePushScope(scope, this.receipt.scope) && !samePushScope(scope, this.blocked) ? this.receipt : null
  }
}
