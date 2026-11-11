import type { GuguMcpContext } from '../acp-engine-utils'
import { passwordNativeMcpIdentity } from '../mcp/password-native-identity'
import type { PasswordApproval, PasswordSaveRequest } from '@gugu/core/shared/passwordBetaProtocol'
import { postPasswordRequest } from './beta-messages'
import type { SaveProposal } from './beta-save'
import { httpsOrigin } from './schema'
import { PASSWORD_AGENT_RPC, releasedSchema, serverDeliveryKey, type RemoteCaller, type RemoteOp } from './server-delivery'
import { openSealed } from './sync-crypto'
import { searchCredentials, type AgentCredential, type CredentialSearch } from './beta-agent-view'
import type { FillInput } from './beta-runtime-port'

/** Polled while the person may still answer the card on their desktop. */
const POLL_MS = 3_000
const POLL_FOR_MS = 31 * 60_000
type Selection = { form: string; account: string; password: string; submitter?: string }
export interface ServerPasswordHost {
  ownerId(): Promise<string | null>
  thisDevice(): Promise<string>
  /** The account's desktops that may keep the vault, likeliest first. */
  desktops(): Promise<string[]>
  call(deviceId: string, payload: RemoteOp, signal?: AbortSignal): Promise<{ result?: unknown; error?: unknown }>
  describe(ownerId: string, agentId: string, sessionId: string): { agentName: string; sessionTitle: string }
  deliver(sessionId: string, requestId: string, status: string): Promise<void>
  deliverSave(sessionId: string, requestId: string, status: string, credentialId?: string): Promise<void>
  /** This server's private home: the delivery key lives there. */
  home(): string
  privateLogin(sessionId: string, input: { url: string; origin: string; selection: Selection; account: string; password: string; signal: AbortSignal }):
    Promise<{ status: string; cookies: number }>
}
const unavailable = () => new Error('password_server_unavailable')

/**
 * The password tools on a Gugu server (「本机送」, server-delivery.ts): the same Agent surface as on a desktop, each step
 * answered by the account's desktop that keeps the vault. The card is posted from the Agent's own session here; the
 * outcome is polled from the desktop and told to that session like a local one.
 */
export function createServerPasswordAgent(host: ServerPasswordHost) {
  let desktop: { id: string; until: number } | undefined
  const logins = new Map<string, { desktop: string; caller: RemoteCaller; url: string; origin: string; selection: Selection; status: string }>()
  const saves = new Map<string, { desktop: string; caller: RemoteCaller }>()

  async function caller(context: GuguMcpContext): Promise<RemoteCaller> {
    const identity = passwordNativeMcpIdentity(context), owner = await host.ownerId()
    if (!identity || !owner || identity.ownerId !== owner) throw unavailable()
    const { agentName, sessionTitle } = host.describe(owner, identity.subjectId, identity.sessionId)
    return { deviceId: await host.thisDevice(), sessionId: identity.sessionId, agentId: identity.subjectId, agentName, sessionTitle }
  }
  async function ask<T>(device: string, payload: RemoteOp, signal?: AbortSignal): Promise<T> {
    const reply = await host.call(device, payload, signal)
    if (reply.error || reply.result === undefined) throw unavailable()
    return reply.result as T
  }
  /** The desktop that answers for the vault; found again when it stops answering. */
  async function vault<T>(payload: RemoteOp): Promise<{ device: string; result: T }> {
    if (desktop && desktop.until > Date.now()) {
      try { return { device: desktop.id, result: await ask<T>(desktop.id, payload) } } catch { desktop = undefined }
    }
    for (const id of await host.desktops()) {
      try {
        const result = await ask<T>(id, payload)
        desktop = { id, until: Date.now() + 5 * 60_000 }
        return { device: id, result }
      } catch { /* not this one */ }
    }
    throw unavailable()
  }
  /** Poll until the person answers (or the desktop ends it), then tell the Agent's session. */
  function watch(read: () => Promise<{ status: string; credentialId?: string }>, done: (value: { status: string; credentialId?: string }) => void) {
    const started = Date.now()
    const tick = async () => {
      if (Date.now() - started > POLL_FOR_MS) return done({ status: 'expired' })
      try {
        const value = await read()
        if (value.status !== 'pending') return done(value)
      } catch { /* offline for a moment: keep polling */ }
      setTimeout(() => void tick(), POLL_MS).unref?.()
    }
    setTimeout(() => void tick(), POLL_MS).unref?.()
  }

  return Object.freeze({
    async list(context: GuguMcpContext, search: CredentialSearch = {}) {
      // The desktop answers with this Agent's view of every credential; the search runs here, the same as on a desktop.
      return searchCredentials((await vault<AgentCredential[]>({ op: 'list', caller: await caller(context) })).result, search)
    },
    async request(context: GuguMcpContext, _lifetime: AbortSignal, input: FillInput) {
      // A server's browser takes a login for now: 账号 and 密码 into one form, from the credential of that website.
      const account = input.fill.filter(entry => !entry.code && ['账号', 'account', 'username', '用户名'].includes(entry.field.trim().toLowerCase()))
      const password = input.fill.filter(entry => !entry.code && ['密码', 'password'].includes(entry.field.trim().toLowerCase()))
      if (!input.credentialId || !input.form || input.fill.length !== 2 || account.length !== 1 || password.length !== 1)
        return { status: 'invalid_request', retry: false, error: 'On a Gugu server, password_fill fills a login: credentialId, form, and fill with 账号 and 密码.' }
      const selection: Selection = { form: input.form, account: account[0]!.into, password: password[0]!.into, ...(input.submit ? { submitter: input.submit } : {}) }
      const who = await caller(context)
      let origin: string
      try { origin = httpsOrigin(new URL(input.url).origin) } catch { throw unavailable() }
      const { device, result } = await vault<{ requestId: string; status: string; view: PasswordApproval }>({ op: 'request', caller: who, credentialId: input.credentialId, origin })
      logins.set(result.requestId, { desktop: device, caller: who, url: input.url, origin, selection, status: result.status })
      if (result.status === 'pending') {
        await postPasswordRequest(context, result.view)
        watch(() => ask<{ status: string }>(device, { op: 'status', caller: who, requestId: result.requestId }), ({ status }) => {
          const login = logins.get(result.requestId)
          if (login) login.status = status
          void host.deliver(who.sessionId, result.requestId, status).catch(() => {})
        })
      }
      return { requestId: result.requestId, status: result.status }
    },
    async status(context: GuguMcpContext, requestId: string) {
      const who = await caller(context), login = logins.get(requestId)
      if (!login || login.caller.sessionId !== who.sessionId) throw unavailable()
      const { status } = await ask<{ status: string }>(login.desktop, { op: 'status', caller: who, requestId })
      login.status = status
      return { status }
    },
    async start(context: GuguMcpContext, requestId: string) {
      const who = await caller(context), login = logins.get(requestId)
      if (!login || login.caller.sessionId !== who.sessionId || login.caller.agentId !== who.agentId) throw unavailable()
      logins.delete(requestId)
      const key = await serverDeliveryKey(host.home())
      const { sealed } = await ask<{ sealed: string }>(login.desktop, { op: 'release', caller: who, requestId, serverKey: key.publicKey })
      const opened = await openSealed(key, sealed)
      let secrets: { account: string; password: string }
      try { secrets = releasedSchema.parse(JSON.parse(opened.toString('utf8'))) } finally { opened.fill(0); key.secretKey.fill(0) }
      const outcome = await host.privateLogin(who.sessionId, { url: login.url, origin: login.origin, selection: login.selection,
        account: secrets.account, password: secrets.password, signal: AbortSignal.timeout(120_000) }).catch(() => ({ status: 'unavailable', cookies: 0 }))
      return { status: outcome.status }
    },
    async save(context: GuguMcpContext, input: SaveProposal & { origin: string; credentialId?: string }) {
      const who = await caller(context)
      const { device, result } = await vault<{ requestId?: string; status: string; credentialId?: string; view?: PasswordSaveRequest }>({ op: 'save', caller: who,
        origin: input.origin, credentialId: input.credentialId, name: input.name, account: input.account, accountSecret: input.accountSecret, password: input.password, fields: input.fields })
      if (result.status !== 'pending' || !result.requestId || !result.view) return { status: result.status, ...(result.credentialId ? { credentialId: result.credentialId } : {}) }
      const requestId = result.requestId
      saves.set(requestId, { desktop: device, caller: who })
      await postPasswordRequest(context, result.view)
      watch(() => ask<{ status: string; credentialId?: string }>(device, { op: 'saveStatus', caller: who, requestId }),
        ({ status, credentialId }) => { void host.deliverSave(who.sessionId, requestId, status, credentialId).catch(() => {}) })
      return { requestId, status: 'pending' }
    },
    async saveStatus(context: GuguMcpContext, requestId: string) {
      const who = await caller(context), save = saves.get(requestId)
      if (!save || save.caller.sessionId !== who.sessionId) throw unavailable()
      return ask<{ status: string; credentialId?: string }>(save.desktop, { op: 'saveStatus', caller: who, requestId })
    },
  })
}
export { PASSWORD_AGENT_RPC }
