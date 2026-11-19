import { randomUUID } from 'node:crypto'
import type { PasswordApproval, PasswordItem } from '@gugu/core/shared/passwordBetaProtocol'
import type { RemoteCaller } from './server-delivery'

/** An approved request is used within this long; a pending one waits for the person this long. */
const PENDING_MS = 10 * 60_000
const APPROVED_MS = 2 * 60_000
type Status = 'pending' | 'approved' | 'rejected' | 'expired' | 'used' | 'invalidated'
type Remote = { view: PasswordApproval; caller: RemoteCaller; item: PasswordItem; status: Status; timer: ReturnType<typeof setTimeout> }

/**
 * 「本机送」 on the desktop that keeps the vault: login requests from Agents on the account's servers. The same card and
 * the same grants as a login here; the difference is that on use the account and password are sealed to that server
 * (server-delivery.ts) instead of typed into a page on this computer. One use per approval.
 */
export class BetaRemoteLogins {
  private readonly requests = new Map<string, Remote>()
  constructor(private readonly host: { deviceId: string; changed(): void; now?: () => number }) {}
  private now() { return this.host.now?.() ?? Date.now() }
  has(requestId: string): boolean { return this.requests.has(requestId) }
  pending(): PasswordApproval[] { return [...this.requests.values()].filter(value => value.status === 'pending').map(value => value.view) }

  request(caller: RemoteCaller, item: PasswordItem, granted: boolean): { requestId: string; status: Status; view: PasswordApproval } {
    // One open request per server session: a looping Agent cannot flood the person's private chat.
    if ([...this.requests.values()].some(value => ['pending', 'approved'].includes(value.status) && value.caller.deviceId === caller.deviceId
      && value.caller.sessionId === caller.sessionId)) throw new Error('password_remote_busy')
    const requestId = randomUUID(), ttl = granted ? APPROVED_MS : PENDING_MS
    const view: PasswordApproval = { kind: 'login', requestId, origin: item.origin, agent: caller.agentId, agentName: caller.agentName,
      sessionTitle: caller.sessionTitle, sessionId: caller.sessionId, deviceId: this.host.deviceId, maskedAccount: item.maskedAccount, expiresAt: this.now() + ttl }
    const timer = setTimeout(() => this.finish(requestId, 'expired'), ttl)
    timer.unref?.()
    this.requests.set(requestId, { view, caller, item, status: granted ? 'approved' : 'pending', timer })
    this.host.changed()
    return { requestId, status: granted ? 'approved' : 'pending', view }
  }
  status(requestId: string, caller: RemoteCaller): Status { return this.mine(requestId, caller).status }
  /** The person's answer on the card. */
  decide(requestId: string, decision: 'allow_once' | 'reject'): void {
    const value = this.requests.get(requestId)
    if (!value || value.status !== 'pending') throw new Error('password_remote_unavailable')
    if (decision === 'reject') { this.finish(requestId, 'rejected'); return }
    clearTimeout(value.timer)
    value.status = 'approved'
    value.timer = setTimeout(() => this.finish(requestId, 'expired'), APPROVED_MS)
    value.timer.unref?.()
    this.host.changed()
  }
  /** Approved, and not used yet: hand the credential to `release` once. */
  async release<T>(requestId: string, caller: RemoteCaller, release: (item: PasswordItem) => Promise<T>): Promise<T> {
    const value = this.mine(requestId, caller)
    if (value.status !== 'approved') throw new Error('password_remote_unavailable')
    this.finish(requestId, 'used')
    return release(value.item)
  }
  invalidate(): void { for (const [requestId, value] of this.requests) if (['pending', 'approved'].includes(value.status)) this.finish(requestId, 'invalidated') }

  private mine(requestId: string, caller: RemoteCaller): Remote {
    const value = this.requests.get(requestId)
    if (!value || value.caller.deviceId !== caller.deviceId || value.caller.sessionId !== caller.sessionId || value.caller.agentId !== caller.agentId)
      throw new Error('password_remote_unavailable')
    return value
  }
  private finish(requestId: string, status: Status): void {
    const value = this.requests.get(requestId)
    if (!value || !['pending', 'approved'].includes(value.status)) return
    clearTimeout(value.timer)
    value.status = status
    // Ended requests stay readable for a while, so the server's next poll sees the outcome.
    const forget = setTimeout(() => { if (this.requests.get(requestId) === value) this.requests.delete(requestId) }, PENDING_MS)
    forget.unref?.()
    this.host.changed()
  }
}
