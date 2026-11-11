import { randomUUID } from 'node:crypto'
import type { PasswordItem, PasswordSaveDraft, PasswordSaveRequest } from '@gugu/core/shared/passwordBetaProtocol'
import type { GuguMcpContext } from '../acp-engine-utils'
import { postPasswordRequest } from './beta-messages'

const unavailable = () => new Error('password_save_unavailable')
/** The person may answer later; a proposal is held in memory only, never on disk or in a message. */
const SAVE_REQUEST_TTL_MS = 30 * 60_000
export interface SaveProposal { account?: string; password?: string; fields?: { name: string; value: string }[] }
export type SaveResult = 'saved' | 'rejected' | 'expired' | 'invalidated'
type Pending = { view: PasswordSaveRequest; draft: PasswordSaveDraft; result: 'pending' | SaveResult; credentialId?: string; timer: ReturnType<typeof setTimeout> }
export interface BetaSaveHost {
  deviceId: string
  changed(): void
  describe(agentId: string, sessionId: string): { agentName: string; sessionTitle: string }
  deliver(sessionId: string, requestId: string, status: SaveResult, credentialId?: string): Promise<void>
}

/** An Agent asks; the person fills or checks the values in Settings and saves. The Agent receives only the outcome. */
export class BetaPasswordSaves {
  private readonly requests = new Map<string, Pending>()
  constructor(private readonly host: BetaSaveHost) {}
  pending(): PasswordSaveRequest[] { return [...this.requests.values()].filter(value => value.result === 'pending').map(value => value.view) }
  async request(context: GuguMcpContext, caller: { agentId: string; sessionId: string }, origin: string, item: PasswordItem | undefined,
    proposal: SaveProposal): Promise<{ requestId: string; status: 'pending' }> {
    // One open request per session: a looping Agent cannot flood the person's private chat.
    if ([...this.requests.values()].some(value => value.result === 'pending' && value.view.sessionId === caller.sessionId)) throw unavailable()
    const requestId = randomUUID(), presentation = this.host.describe(caller.agentId, caller.sessionId)
    const view: PasswordSaveRequest = { kind: 'save', requestId, origin, ...(item ? { credentialId: item.reference.id, maskedAccount: item.maskedAccount } : {}),
      agent: caller.agentId, ...presentation, sessionId: caller.sessionId, deviceId: this.host.deviceId, expiresAt: Date.now() + SAVE_REQUEST_TTL_MS }
    const fields = (proposal.fields ?? []).map(field => ({ id: item?.fields.find(value => value.name === field.name)?.id ?? randomUUID(), name: field.name, value: field.value }))
    const draft: PasswordSaveDraft = { origin, account: proposal.account ?? '', password: proposal.password ?? '', fields, agentName: presentation.agentName,
      ...(item ? { credentialId: item.reference.id } : {}) }
    const timer = setTimeout(() => this.finish(requestId, 'expired'), SAVE_REQUEST_TTL_MS)
    timer.unref?.()
    this.requests.set(requestId, { view, draft, result: 'pending', timer })
    try { await postPasswordRequest(context, view) }
    catch { this.drop(requestId); throw unavailable() }
    this.host.changed()
    return { requestId, status: 'pending' }
  }
  /** Person-only: the values the Agent proposed, for the person's own form. */
  draft(requestId: string): PasswordSaveDraft {
    const value = this.open(requestId)
    return { ...value.draft, fields: value.draft.fields.map(field => ({ ...field })) }
  }
  /** Person-only: the request being completed. Throws unless it is still open. */
  open(requestId: string): Pending {
    const value = this.requests.get(requestId)
    if (!value || value.result !== 'pending') throw unavailable()
    return value
  }
  complete(requestId: string, credentialId: string): void { this.finish(requestId, 'saved', credentialId) }
  reject(requestId: string): void { this.open(requestId); this.finish(requestId, 'rejected') }
  status(requestId: string, sessionId: string): { status: string; credentialId?: string } {
    const value = this.requests.get(requestId)
    if (!value || value.view.sessionId !== sessionId) throw unavailable()
    return { status: value.result, ...(value.credentialId ? { credentialId: value.credentialId } : {}) }
  }
  invalidate(): void { for (const [requestId, value] of this.requests) if (value.result === 'pending') this.finish(requestId, 'invalidated') }
  private finish(requestId: string, result: SaveResult, credentialId?: string): void {
    const value = this.requests.get(requestId)
    if (!value || value.result !== 'pending') return
    clearTimeout(value.timer)
    value.result = result
    if (credentialId) value.credentialId = credentialId
    this.wipe(value)
    void this.host.deliver(value.view.sessionId, requestId, result, credentialId).catch(() => {})
    this.host.changed()
  }
  private drop(requestId: string): void {
    const value = this.requests.get(requestId)
    if (!value) return
    clearTimeout(value.timer); this.wipe(value); this.requests.delete(requestId)
  }
  private wipe(value: Pending): void {
    value.draft.account = ''; value.draft.password = ''
    for (const field of value.draft.fields) field.value = ''
  }
}
