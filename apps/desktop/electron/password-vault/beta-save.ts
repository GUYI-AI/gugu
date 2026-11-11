import { randomUUID } from 'node:crypto'
import type { PasswordItem, PasswordSaveDraft, PasswordSaveRequest } from '@gugu/core/shared/passwordBetaProtocol'
import type { GuguMcpContext } from '../acp-engine-utils'
import { postPasswordRequest } from './beta-messages'
import { maskedAccount } from './schema'

const unavailable = () => new Error('password_save_unavailable')
/** The person may answer later; a proposal is held in memory only, never on disk or in a message. */
const SAVE_REQUEST_TTL_MS = 30 * 60_000
/** What an Agent proposes. A field without a value is one the person fills in; `secret` defaults to true. */
export interface SaveProposal { name?: string; account?: string; accountSecret?: boolean; password?: string; fields?: { name: string; value?: string; secret?: boolean }[] }
export type SaveResult = 'saved' | 'rejected' | 'expired' | 'invalidated'
type Pending = { view: PasswordSaveRequest; draft: PasswordSaveDraft; result: 'pending' | SaveResult; credentialId?: string; timer: ReturnType<typeof setTimeout>; remote?: string }
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
  /** context null: an Agent on one of the account's servers (「本机送」). That server posts the card and polls the outcome. */
  async request(context: GuguMcpContext | null, caller: { agentId: string; sessionId: string }, origin: string, item: PasswordItem | undefined,
    proposal: SaveProposal, remote?: { agentName: string; sessionTitle: string; remote: string }): Promise<{ requestId: string; status: 'pending'; view: PasswordSaveRequest }> {
    // One open request per session: a looping Agent cannot flood the person's private chat.
    if ([...this.requests.values()].some(value => value.result === 'pending' && value.view.sessionId === caller.sessionId)) throw unavailable()
    const requestId = randomUUID(), presentation = remote ? { agentName: remote.agentName, sessionTitle: remote.sessionTitle } : this.host.describe(caller.agentId, caller.sessionId)
    // The card shows the account the Agent proposed (masked like every stored one), else the stored one.
    const shown = proposal.account ? maskedAccount(proposal.account) : item?.maskedAccount
    const fields = (proposal.fields ?? []).map(field => {
      const stored = item?.fields.find(value => value.name === field.name)
      return { id: stored?.id ?? randomUUID(), name: field.name, value: field.value ?? '', secret: field.secret ?? stored?.secret ?? true }
    })
    // The card is the form: an account and a password unless the Agent proposed only named values (an API key).
    const login = proposal.account !== undefined || proposal.password !== undefined || !fields.length
    const inputs = [...(login ? [{ key: 'account', name: '账号', secret: proposal.accountSecret ?? item?.accountSecret ?? false }, { key: 'password', name: '密码', secret: true }] : []),
      ...fields.map(field => ({ key: field.id, name: field.name, secret: field.secret }))]
    const view: PasswordSaveRequest = { kind: 'save', requestId, origin, ...(item ? { credentialId: item.reference.id } : {}), ...(shown ? { maskedAccount: shown } : {}),
      agent: caller.agentId, ...presentation, sessionId: caller.sessionId, deviceId: this.host.deviceId, expiresAt: Date.now() + SAVE_REQUEST_TTL_MS, inputs }
    const draft: PasswordSaveDraft = { origin, ...(proposal.name !== undefined ? { name: proposal.name } : {}), account: proposal.account ?? '',
      ...(proposal.accountSecret !== undefined ? { accountSecret: proposal.accountSecret } : {}), password: proposal.password ?? '', fields, agentName: presentation.agentName,
      ...(item ? { credentialId: item.reference.id } : {}) }
    const timer = setTimeout(() => this.finish(requestId, 'expired'), SAVE_REQUEST_TTL_MS)
    timer.unref?.()
    this.requests.set(requestId, { view, draft, result: 'pending', timer, ...(remote ? { remote: remote.remote } : {}) })
    if (context) {
      try { await postPasswordRequest(context, view) }
      catch { this.drop(requestId); throw unavailable() }
    }
    this.host.changed()
    return { requestId, status: 'pending', view }
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
    // A server's request: that server polls the outcome and tells its own session.
    if (!value.remote) void this.host.deliver(value.view.sessionId, requestId, result, credentialId).catch(() => {})
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
