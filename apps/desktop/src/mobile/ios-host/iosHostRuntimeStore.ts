import type { IOSOwnerBinding } from '../ios-runtime/iosOwnerClient'
import { IOSAgentError, iosHostFailure, sameIOSBinding, type IOSAgentClient, type IOSHostState } from './iosAgentClient'
import { IOSNotificationsSettings, type IOSNotificationsMeta, type IOSNotificationsValue } from './iosNotificationsSettings'

export interface IOSHostOwnerSource {
  getSnapshot(): { status: string; binding: IOSOwnerBinding | null; error?: { code: string; message: string } | null }
  subscribe(changed: () => void): () => void
}
export interface IOSHostRuntimeSnapshot {
  phase: 'inactive' | 'waiting' | 'unavailable' | 'starting' | 'configured' | 'failed' | 'stopping' | 'stopped'
  binding: IOSOwnerBinding | null
  host: IOSHostState | null
  settings: { status: 'unknown' | 'loading' | 'ready'; meta: IOSNotificationsMeta | null; error: IOSAgentError | null }
  error: IOSAgentError | null
}
const unknownSettings = (): IOSHostRuntimeSnapshot['settings'] => ({ status: 'unknown', meta: null, error: null })

/** Projection of OwnerPublication, not an auth session or credential owner. */
export class IOSHostRuntimeStore {
  private state: IOSHostRuntimeSnapshot = { phase: 'inactive', binding: null, host: null, settings: unknownSettings(), error: null }
  private readonly listeners = new Set<() => void>()
  private subscribers = 0
  private epoch = 0
  private desired: IOSOwnerBinding | null = null
  private configured: IOSOwnerBinding | null = null
  private configureSequence = 0
  private configuration: { binding: IOSOwnerBinding; flight: Promise<IOSHostState> } | null = null
  private stopSource: (() => void) | null = null
  private stopListener: (() => Promise<void>) | null = null
  private flight: Promise<void> = Promise.resolve()
  private settingsSequence = 0
  private stateSequence = 0
  private failedStop: IOSOwnerBinding | null = null
  private paused: IOSOwnerBinding | null = null

  constructor(private readonly owner: IOSHostOwnerSource, private readonly client: IOSAgentClient, private readonly label?: string) {}
  getSnapshot = (): IOSHostRuntimeSnapshot => this.state
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  whenIdle = (): Promise<void> => this.flight

  /** Detaching subscriptions withdraws the projection; A owns native retirement. */
  start(): () => void {
    if (++this.subscribers === 1) {
      this.stopSource = this.owner.subscribe(() => this.synchronize())
      this.synchronize()
    }
    let attached = true
    return () => {
      if (!attached) return
      attached = false
      if (--this.subscribers !== 0) return
      ++this.epoch; ++this.settingsSequence; this.desired = null
      this.stopSource?.(); this.stopSource = null
      this.removeListener()
      this.set({ phase: 'inactive', binding: null, host: null, settings: unknownSettings(), error: null })
    }
  }

  private synchronize(force = false): void {
    if (!this.subscribers) return
    const publication = this.owner.getSnapshot()
    const next = publication.status === 'ready' && publication.binding ? { ...publication.binding } : null
    if (!next) {
      ++this.epoch; ++this.settingsSequence; this.desired = null; this.removeListener()
      this.set({ phase: publication.status === 'failed' ? 'failed' : publication.status === 'unavailable' ? 'unavailable' : 'waiting',
        binding: null, host: null, settings: unknownSettings(), error: publication.error ? new IOSAgentError(publication.error.code, publication.error.message) : null })
      return
    }
    if (!force && sameIOSBinding(next, this.desired)) return
    this.desired = next
    const epoch = ++this.epoch
    ++this.settingsSequence; this.removeListener()
    if (sameIOSBinding(next, this.failedStop)) {
      this.set({ phase: 'failed', binding: next, host: null, settings: unknownSettings(), error: this.state.error ?? new IOSAgentError('stop_failed', '本机宿主尚未停止，请重试。') })
      return
    }
    if (sameIOSBinding(next, this.paused)) {
      this.set({ phase: 'stopped', binding: next, host: null, settings: unknownSettings(), error: null }); return
    }
    if (!this.client.available()) {
      this.set({ phase: 'unavailable', binding: next, host: null, settings: unknownSettings(), error: null }); return
    }
    this.set({ phase: 'starting', binding: next, host: null, settings: unknownSettings(), error: null })
    const run = this.connect(next, epoch)
    this.flight = run
    void run.catch(() => undefined) // Error is also retained in the projection.
  }
  private current(binding: IOSOwnerBinding, epoch: number): boolean {
    const publication = this.owner.getSnapshot()
    return this.subscribers > 0 && this.epoch === epoch && publication.status === 'ready'
      && sameIOSBinding(publication.binding, binding) && sameIOSBinding(this.desired, binding)
  }
  private require(binding: IOSOwnerBinding, epoch: number): void {
    if (!this.current(binding, epoch)) throw new IOSAgentError('stale_context', '本机宿主身份已变化。')
  }
  private async configuredState(binding: IOSOwnerBinding, epoch: number): Promise<IOSHostState> {
    this.require(binding, epoch)
    if (sameIOSBinding(this.configured, binding)) {
      try { return await this.client.state(binding) }
      catch (cause) {
        this.require(binding, epoch)
        if ((cause as { code?: unknown } | null)?.code !== 'host_not_ready') throw cause
        // A may have retired a previous Auth session with this same phone ID.
        // Probe first; configure only when native confirms there is no host.
        if (sameIOSBinding(this.configured, binding)) this.configured = null
      }
    }
    if (sameIOSBinding(this.configuration?.binding ?? null, binding)) return this.configuration!.flight
    const sequence = ++this.configureSequence
    const flight = this.client.configure(binding, this.label).then(state => {
      if (sequence === this.configureSequence) this.configured = binding
      return state
    })
    this.configuration = { binding, flight }
    void flight.finally(() => { if (this.configuration?.flight === flight) this.configuration = null }).catch(() => undefined)
    return flight
  }
  private async connect(binding: IOSOwnerBinding, epoch: number): Promise<void> {
    try {
      const host = await this.configuredState(binding, epoch)
      this.require(binding, epoch)
      this.set({ phase: 'configured', binding, host, settings: unknownSettings(), error: null })
      this.require(binding, epoch)
      const remove = await this.client.listen(binding, () => {
        if (this.current(binding, epoch)) {
          const run = this.readState(binding, epoch); this.flight = run; void run.catch(() => undefined)
        }
      })
      if (!this.current(binding, epoch)) { await remove(); return }
      this.stopListener = remove
      // Read after listener installation, closing its asynchronous registration gap.
      await this.readState(binding, epoch)
      this.require(binding, epoch)
      await this.loadSettings(binding, epoch)
    } catch (cause) {
      if (this.current(binding, epoch)) this.set({ ...this.state, phase: 'failed', error: iosHostFailure(cause) })
      throw cause
    }
  }
  private async readState(binding: IOSOwnerBinding, epoch: number): Promise<void> {
    const sequence = ++this.stateSequence
    try {
      this.require(binding, epoch)
      const host = await this.client.state(binding)
      this.require(binding, epoch)
      if (sequence === this.stateSequence) this.set({ ...this.state, host })
    } catch (cause) {
      if (this.current(binding, epoch) && sequence === this.stateSequence) this.set({ ...this.state, phase: 'failed', host: null, settings: unknownSettings(), error: iosHostFailure(cause) })
      throw cause
    }
  }
  private settingsBridge(binding: IOSOwnerBinding, epoch: number): IOSNotificationsSettings {
    return new IOSNotificationsSettings(this.client, binding, () => this.require(binding, epoch))
  }
  private async loadSettings(binding: IOSOwnerBinding, epoch: number): Promise<void> {
    const sequence = ++this.settingsSequence
    this.set({ ...this.state, settings: { status: 'loading', meta: null, error: null } })
    try {
      const meta = await this.settingsBridge(binding, epoch).getWithMeta()
      if (this.current(binding, epoch) && sequence === this.settingsSequence) this.set({ ...this.state, settings: { status: 'ready', meta, error: null } })
    } catch (cause) {
      if (this.current(binding, epoch) && sequence === this.settingsSequence) this.set({ ...this.state, settings: { status: 'unknown', meta: null, error: iosHostFailure(cause) } })
    }
  }
  async updateNotifications(value: IOSNotificationsValue, originalId: string): Promise<IOSNotificationsMeta> {
    const binding = this.desired, epoch = this.epoch
    if (!binding || this.state.phase !== 'configured') throw new IOSAgentError('host_not_ready', '本机设置入口尚未配置。')
    this.require(binding, epoch)
    const sequence = ++this.settingsSequence
    this.set({ ...this.state, settings: { status: 'loading', meta: null, error: null } })
    try {
      const meta = await this.settingsBridge(binding, epoch).update(value, originalId)
      this.require(binding, epoch)
      if (sequence !== this.settingsSequence) throw new IOSAgentError('stale_context', '本机设置请求已被替代。')
      this.set({ ...this.state, settings: { status: 'ready', meta, error: null } }); return meta
    } catch (cause) {
      if (this.current(binding, epoch) && sequence === this.settingsSequence) this.set({ ...this.state, settings: { status: 'unknown', meta: null, error: iosHostFailure(cause) } })
      throw cause
    }
  }
  /** Explicit local stop. Native credential-backed cleanup remains A's barrier. */
  async stopHost(): Promise<void> {
    const binding = this.desired ?? this.configured
    if (!binding) return
    const publication = this.owner.getSnapshot()
    if (!this.subscribers || publication.status !== 'ready' || !sameIOSBinding(publication.binding, binding)) {
      throw new IOSAgentError('stale_context', '本机宿主身份已变化。')
    }
    const epoch = ++this.epoch
    ++this.settingsSequence; ++this.configureSequence; this.removeListener()
    this.configuration = null
    this.paused = binding
    this.set({ phase: 'stopping', binding, host: null, settings: unknownSettings(), error: null })
    try {
      await this.client.stop(binding)
      if (sameIOSBinding(this.configured, binding)) this.configured = null
      if (sameIOSBinding(this.failedStop, binding)) this.failedStop = null
      if (this.epoch === epoch) this.set({ phase: 'stopped', binding, host: null, settings: unknownSettings(), error: null })
    } catch (cause) {
      this.failedStop = binding
      if (this.epoch === epoch) this.set({ ...this.state, phase: 'failed', error: iosHostFailure(cause) })
      throw cause
    }
  }
  async retry(): Promise<void> {
    if (this.failedStop && sameIOSBinding(this.failedStop, this.desired)) await this.stopHost()
    this.paused = null
    this.synchronize(true)
    await this.flight
  }
  private removeListener(): void {
    const remove = this.stopListener; this.stopListener = null
    if (remove) void remove().catch(() => { /* callbacks retain their withdrawn scope guard */ })
  }
  private set(value: IOSHostRuntimeSnapshot): void { this.state = value; this.listeners.forEach(listener => listener()) }
}
