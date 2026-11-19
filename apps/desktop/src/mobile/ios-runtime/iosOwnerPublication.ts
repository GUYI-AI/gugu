import type { SessionCoordinatorSnapshot } from '@/lib/sessionCoordinator'
import { IOSOwnerClientError, type IOSOwnerBinding, type IOSOwnerClient } from './iosOwnerClient'

export interface IOSOwnerSessionSource {
  getSnapshot(): Pick<SessionCoordinatorSnapshot, 'status' | 'session'> & Partial<Pick<SessionCoordinatorSnapshot, 'error'>>
  subscribe(listener: () => void): () => void
  captureAuthHandoff(): Promise<unknown>
}
export type IOSOwnerPublicationState =
  | { status: 'unavailable' | 'waiting' | 'publishing' | 'retiring' | 'stopped'; binding: null; error: null }
  | { status: 'ready'; binding: IOSOwnerBinding; error: null }
  | { status: 'failed'; binding: null; error: { code: string; message: string } }

type SessionProjection = { ownerId: string; accessToken: string; expiresAt: number }
const OWNER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
function project(source: IOSOwnerSessionSource, now: number): SessionProjection | null {
  const { status, session } = source.getSnapshot()
  if ((status !== 'authenticated' && status !== 'degraded') || !session?.user.id || !OWNER_ID.test(session.user.id) || !session.access_token
    || !Number.isFinite(session.expires_at) || session.expires_at! * 1_000 <= now) return null
  return { ownerId: session.user.id, accessToken: session.access_token, expiresAt: session.expires_at! * 1_000 }
}
function same(a: SessionProjection | null | undefined, b: SessionProjection | null): boolean {
  return a === b || !!a && !!b && a.ownerId === b.ownerId && a.accessToken === b.accessToken && a.expiresAt === b.expiresAt
}
function safeFailure(cause: unknown, retiring = false): { code: string; message: string } {
  if (retiring) return { code: 'retirement_failed', message: '本机身份退役尚未完成，请重试。' }
  if (cause instanceof IOSOwnerClientError) return { code: cause.code, message: cause.message }
  const code = (cause as { code?: unknown } | null)?.code
  if (code === 'stale_context') return { code, message: '账号或这台手机的身份已变化，请重新核验。' }
  if (code === 'not_granted') return { code, message: '当前会话尚未通过本机身份核验。' }
  return { code: 'publication_failed', message: '未能核验本机身份，请重试。' }
}

/** A projection of the existing coordinator. It never starts, refreshes or signs out an auth session. */
export class IOSOwnerPublication {
  private active = false
  private generation = 0
  private desired: SessionProjection | null | undefined
  private coordinatorStatus: string | undefined
  private coordinatorError: unknown
  private nativeOwner: string | null = null
  private retirementFailed = false
  private retirement: Promise<void> | null = null
  private flight: Promise<void> = Promise.resolve()
  private stopSource: (() => void) | null = null
  private stopForeground: (() => void) | null = null
  private expiry: ReturnType<typeof setTimeout> | null = null
  private state: IOSOwnerPublicationState = { status: 'stopped', binding: null, error: null }
  private readonly listeners = new Set<() => void>()

  constructor(private readonly source: IOSOwnerSessionSource, private readonly client: IOSOwnerClient,
    private readonly foreground: (changed: () => void, failed: (error: unknown) => void) => () => void,
    private readonly now: () => number = Date.now) {}

  getSnapshot = (): IOSOwnerPublicationState => this.state
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener) }

  start(): void {
    if (this.active) return
    this.active = true
    this.stopSource = this.source.subscribe(() => { void this.synchronize() })
    this.stopForeground = this.foreground(() => { void this.refresh() }, cause => {
      if (!this.active) return
      ++this.generation
      this.clearExpiry()
      this.setState({ status: 'failed', binding: null, error: safeFailure(cause) })
    })
    void this.refresh()
  }
  refresh = (): Promise<void> => this.synchronize(true)

  async stop(): Promise<void> {
    this.active = false
    const generation = ++this.generation
    this.desired = undefined
    this.stopSource?.(); this.stopSource = null
    this.stopForeground?.(); this.stopForeground = null
    this.clearExpiry()
    this.setState({ status: this.nativeOwner ? 'retiring' : 'stopped', binding: null, error: null })
    try {
      await this.retireNative()
      if (generation === this.generation) this.setState({ status: 'stopped', binding: null, error: null })
    }
    catch (cause) {
      if (generation === this.generation) this.setState({ status: 'failed', binding: null, error: safeFailure(cause, true) })
      throw Object.assign(new Error('本机身份退役尚未完成，请重试。'), { code: 'retirement_failed' })
    }
  }

  private synchronize(force = false): Promise<void> {
    if (!this.active) return Promise.resolve()
    const coordinator = this.source.getSnapshot()
    const coordinatorChanged = coordinator.status !== this.coordinatorStatus || coordinator.error !== this.coordinatorError
    this.coordinatorStatus = coordinator.status
    this.coordinatorError = coordinator.error
    const desired = project(this.source, this.now())
    if (same(this.desired, desired) && !coordinatorChanged && (!force || this.state.status === 'publishing' || this.state.status === 'retiring')) return this.flight
    this.desired = desired
    const generation = ++this.generation
    this.clearExpiry()
    if (desired) this.expiry = setTimeout(() => { void this.synchronize(true) }, Math.min(2_147_483_647, Math.max(0, desired.expiresAt - this.now())))
    // Withdraw the old identity before awaiting any native operation or auth barrier.
    this.setState({ status: this.client.available() ? desired ? 'publishing' : 'waiting' : 'unavailable', binding: null, error: null })
    const flight = this.run(desired, generation)
    this.flight = flight
    return flight
  }

  private current(desired: SessionProjection | null, generation: number): boolean {
    return this.active && generation === this.generation && same(desired, project(this.source, this.now()))
  }

  private async run(desired: SessionProjection | null, generation: number): Promise<void> {
    try {
      if (this.retirement) {
        if (this.current(desired, generation)) this.setState({ status: 'retiring', binding: null, error: null })
        try { await this.retirement }
        catch (cause) { if (!desired || this.nativeOwner === desired.ownerId) throw cause }
      }
      if (!this.current(desired, generation)) return
      if (desired && this.nativeOwner && this.nativeOwner !== desired.ownerId) {
        // The coordinator publishes only after Keychain prepareMainWrite retires
        // the old owner. retire(oldOwner) after this commit must reject, not stop
        // the new owner. Native publish still rejects any unresolved retirement.
        this.nativeOwner = null
        this.retirementFailed = false
      }
      if (this.nativeOwner && (!desired || this.retirementFailed)) {
        if (this.current(desired, generation)) this.setState({ status: 'retiring', binding: null, error: null })
        await this.retireNative()
      }
      if (!this.current(desired, generation)) return
      if (!this.client.available()) { this.setState({ status: 'unavailable', binding: null, error: null }); return }
      if (!desired) { this.setState({ status: 'waiting', binding: null, error: null }); return }
      await this.source.captureAuthHandoff()
      if (!this.current(desired, generation)) return
      this.setState({ status: 'publishing', binding: null, error: null })
      // Include pending publications in retirement even before their first reply arrives.
      this.nativeOwner = desired.ownerId
      const binding = await this.client.publish({ ownerId: desired.ownerId, accessToken: desired.accessToken })
      if (!this.current(desired, generation)) return
      const current = await this.client.getBinding(desired.ownerId)
      if (!this.current(desired, generation)) return
      // A newer auth write may have begun after the initial barrier while its
      // coordinator snapshot still shows the old session. Wait for that write too.
      await this.source.captureAuthHandoff()
      if (!this.current(desired, generation)) return
      if (!current || current.ownerId !== desired.ownerId || current.ownerId !== binding.ownerId || current.deviceId !== binding.deviceId
        || current.installationId !== binding.installationId) throw new IOSOwnerClientError('invalid_native_reply', '本机身份核验结果已变化，请重试。')
      this.setState({ status: 'ready', binding: current, error: null })
    } catch (cause) {
      if (this.current(desired, generation)) this.setState({ status: 'failed', binding: null, error: safeFailure(cause, this.retirementFailed) })
    }
  }

  private retireNative(): Promise<void> {
    if (this.retirement) return this.retirement
    const owner = this.nativeOwner
    if (!owner) return Promise.resolve()
    const flight = this.client.retire(owner).then(() => {
      if (this.nativeOwner === owner) this.nativeOwner = null
      this.retirementFailed = false
    }, cause => { this.retirementFailed = true; throw cause })
    this.retirement = flight
    const clear = () => { if (this.retirement === flight) this.retirement = null }
    void flight.then(clear, clear)
    return flight
  }
  private clearExpiry(): void { if (this.expiry !== null) clearTimeout(this.expiry); this.expiry = null }
  private setState(state: IOSOwnerPublicationState): void { this.state = state; this.listeners.forEach(listener => listener()) }
}
