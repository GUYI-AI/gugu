import { app, ipcMain, type BrowserWindow } from 'electron'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { PASSWORD_BETA_ENABLED } from '@gugu/core/shared/passwordBeta'
import { passwordGrantLevel, type PasswordUiCommand, type PasswordUiReply, type PasswordSnapshot } from '@gugu/core/shared/passwordBetaProtocol'
import { privatePasswordVaultDirectory, PASSWORD_VAULT_STORAGE } from '@gugu/core/local/state/protectedPrivateStorage'
import { protectedPrivateStorageStatus } from '@gugu/core/local/state/agentFileBoundary'
import { createBetaPasswordAccess } from '../permissions/password-beta-access'
import type { PermissionPolicy } from '../permissions/rules'
import { guguMcpToolScope, passwordNativeMcpIdentity } from '../mcp/password-native-identity'
import type { GuguMcpContext } from '../acp-engine-utils'
import { createVaultStorage } from './host'
import { macVaultKeyProtector } from './mac'
import { VaultError, type CredentialGrant } from './contracts'
import { httpsOrigin } from './schema'
import { passwordGrantCandidates, passwordGrantSubjects, passwordRequestPresentation } from '../session/main/core/sessions/password-beta-presentation'
import { BetaPasswordLogin } from './beta-login'
import { BetaPasswordSaves, type SaveProposal, type SaveResult } from './beta-save'
import { SyncError, VaultSync, syncDirectory } from './sync'
import { sealTo } from './sync-crypto'
import { BetaRemoteLogins } from './beta-remote'
import { PASSWORD_AGENT_RPC, remoteOpSchema, type RemoteCaller } from './server-delivery'
import { agentCredential, planAgentSave, searchCredentials, type CredentialSearch } from './beta-agent-view'
import type { FillInput } from './beta-runtime-port'

export const PASSWORD_UI_CHANNEL = 'gugu:password-beta-ui'
export const PASSWORD_CHANGED_CHANNEL = 'gugu:password-beta-changed'
interface NativeHost { window(): BrowserWindow | null; account(): Promise<string | null>; device(): string | null | Promise<string | null>;
  deliver(sessionId: string, requestId: string, status: string): Promise<void>;
  deliverSave(sessionId: string, requestId: string, status: SaveResult, credentialId?: string): Promise<void>;
  readPolicy(ownerId: string, signal: AbortSignal): Promise<PermissionPolicy>
  /** System owner verification (Touch ID or login password) through the native helper. */
  verifyOwner(reason: string): Promise<void>
  /** Signed-in identity-schema RPC for vault sync; throws the backend error (with its SQLSTATE `code`). */
  rpc(name: string, args: Record<string, unknown>): Promise<unknown>
  /** Is the person at this machine: used in the last half minute, idle but unlocked, or locked. */
  presence(): 'active' | 'idle' | 'locked'
  /** A system notification that brings the window forward when clicked; nothing when the window already has focus. */
  notify(title: string, body: string): void }
type Account = Awaited<ReturnType<typeof createAccount>>
let native: NativeHost | undefined
let current: Account | undefined
let creating: Promise<Account> | undefined
const unavailable = () => new VaultError('UNAVAILABLE')
const person = Object.freeze({})
const changed = () => {
  const window = native?.window()
  if (window && !window.isDestroyed()) window.webContents.send(PASSWORD_CHANGED_CHANNEL)
}
async function createAccount(ownerId: string, host: NativeHost) {
  const controller = new AbortController(), root = join(privatePasswordVaultDirectory(), ownerId)
  const assertCurrent = () => { controller.signal.throwIfAborted(); if (current && current.ownerId !== ownerId) throw unavailable() }
  const protection = async () => { if ((await protectedPrivateStorageStatus(PASSWORD_VAULT_STORAGE)).status !== 'ready') throw unavailable() }
  await protection()
  const access = createBetaPasswordAccess({ signal: controller.signal, toolScope: guguMcpToolScope,
    readPolicy: async (owner, signal) => {
      if (await host.account() !== ownerId || owner !== ownerId) throw unavailable()
      assertCurrent()
      return host.readPolicy(owner, signal)
    } })
  const deviceId = await host.device()
  if (!deviceId) throw unavailable()
  const describe = (agentId: string, sessionId: string) => passwordRequestPresentation(ownerId, agentId, sessionId)
  const login = new BetaPasswordLogin({ ownerId, deviceId, signal: controller.signal, access, assertCurrent, changed, describe,
    subjects: (agentId, sessionId) => passwordGrantSubjects(ownerId, agentId, sessionId), denied: () => false, deliver: host.deliver,
    remember: async ({ credentialId, origin, subject, values }) => {
      const items = await vault.list(person)
      const item = credentialId ? items.find(entry => entry.reference.id === credentialId) : undefined
      if (credentialId && !item) return
      const pick = (key: string) => values.find(entry => entry.key === key)
      // Blank keeps a stored value; a value typed on the card replaces it or is added under its name.
      const fields = [...(item?.fields ?? []).map(field => ({ id: field.id, name: field.name, value: pick(field.id)?.value ?? '', secret: pick(field.id)?.secret ?? field.secret })),
        // The person's own items (「+ 添加一项」) are fields whatever their name; only typed values named 账号/密码 are those.
        ...values.filter(entry => (entry.key.startsWith('extra:') || entry.key.startsWith('typed:') && !['账号', '密码'].includes(entry.name)) && entry.value)
          .map(entry => ({ id: randomUUID(), name: entry.name, value: entry.value, secret: entry.secret }))]
      const typedAs = (name: string) => values.find(entry => entry.key.startsWith('typed:') && entry.name === name)
      const account = pick('account') ?? typedAs('账号'), password = pick('password') ?? typedAs('密码')
      const sites = item ? (item.origin === origin || item.sites.includes(origin) ? item.sites : [...item.sites, origin]) : []
      const grant = subject ? { subject, level: 'read' as const } : undefined
      const saved = await vault.save(person, randomUUID(), { origin: item?.origin ?? origin, ...(item ? {} : { name: new URL(origin).hostname }), account: account?.value ?? '',
        accountSecret: account?.secret ?? item?.accountSecret ?? false, password: password?.value ?? '', fields, sites }, item?.reference, item ? undefined : grant)
      if (item && grant && !saved.grants.some(entry => entry.subject === grant.subject)) await vault.setGrants(person, saved.reference, [...saved.grants, grant])
      changed()
    } })
  const saves = new BetaPasswordSaves({ deviceId, changed, describe, deliver: host.deliverSave })
  const remote = new BetaRemoteLogins({ deviceId, changed })
  const keys = macVaultKeyProtector(reason => host.verifyOwner(reason))
  // The vault publishes through this port before each local commit; the engine exists once the vault does.
  const port: { sync?: VaultSync } = {}
  const { vault } = createVaultStorage({ root, accountId: ownerId, installationBinding: app.getPath('userData'),
    sync: { publish: change => port.sync ? port.sync.publish(change) : Promise.resolve() },
    assertLocalPerson: value => { assertCurrent(); if (value !== person) throw unavailable() },
    assertOwnedLocalAgent: value => { assertCurrent(); if (value !== person) throw unavailable() },
    assertPrivateStorageReady: protection, keys,
    invalidate: async () => { login.invalidate(); remote.invalidate() },
  }, login.sink, async (operation, signal) => {
    if (!PASSWORD_BETA_ENABLED || await host.account() !== ownerId) throw unavailable()
    const result = await access.acquireFeatureGuard(operation, signal)
    if (result.status !== 'ready') throw unavailable()
    return result
  })
  login.bindVault(vault)
  const sync = port.sync = new VaultSync({ root: syncDirectory(privatePasswordVaultDirectory(), ownerId), ownerId, deviceId, keys, changed,
    rpc: async (name, args) => { assertCurrent(); if (await host.account() !== ownerId) throw unavailable(); return host.rpc(name, args) },
    vault: { syncExport: () => vault.syncExport(person), syncApply: changes => vault.syncApply(person, changes) } })
  return { ownerId, vault, login, saves, remote, controller, assertCurrent, sync, pull: pulling(sync, host, controller.signal) }
}
/** Polls the head revision every 5 seconds (3 while a code is on screen) and pulls when something was written, and every
 * minute regardless. Every step of joining writes, so both devices see the other's step at the next poll. Failures wait
 * for the next round; nothing is shown.
 * A device asking to join is opened on the machine the person is at: at once where they are active, after a pause where
 * the screen is merely unlocked, never where it is locked; an active machine also takes over a request opened elsewhere. */
function pulling(sync: VaultSync, host: Pick<NativeHost, 'presence' | 'notify'>, signal: AbortSignal) {
  let timer: ReturnType<typeof setTimeout> | undefined, last = 0, running = false, forced = false
  const seen = new Map<string, number>()
  const urgent = () => {
    const view = sync.view()
    return view.state === 'joining' && !!view.code || view.state === 'ready' && view.requests.some(request => request.stage === 'waiting' || request.stage === 'compare')
  }
  const claim = async () => {
    const view = sync.view()
    if (view.state !== 'ready') { seen.clear(); return }
    for (const id of seen.keys()) if (!view.requests.some(request => request.deviceId === id)) seen.delete(id)
    const presence = host.presence()
    for (const request of view.requests) {
      if (!seen.has(request.deviceId)) { seen.set(request.deviceId, Date.now()); host.notify(`「${request.label || '新设备'}」想用你的密码`, '打开咕咕，核对两台设备上的数字。') }
      const waited = Date.now() - seen.get(request.deviceId)! > 8_000
      if (presence !== 'locked' && request.stage === 'new' && (presence === 'active' || waited) || presence === 'active' && request.stage === 'elsewhere')
        await sync.challenge(request.deviceId).catch(() => {})
    }
  }
  const run = async () => {
    if (signal.aborted || running) return
    running = true
    try {
      const full = forced || Date.now() - last > 60_000
      forced = false
      if (full || await sync.poll()) { last = Date.now(); await sync.refresh() }
      // Every round, not only after a pull: a request waits out its pause on a merely unlocked machine without any write.
      await claim()
    } catch { /* offline or not signed in: the next round retries */ }
    finally { running = false; schedule(urgent() ? 3_000 : 5_000) }
  }
  const schedule = (delay: number) => {
    if (signal.aborted) return
    clearTimeout(timer); timer = setTimeout(() => void run(), delay); timer.unref?.()
  }
  signal.addEventListener('abort', () => { clearTimeout(timer); sync.dispose() }, { once: true })
  forced = true; schedule(0)
  return {
    /** The settings page or a prompt asked: pull soon, at most every 10 seconds. */
    soon: () => { if (Date.now() - last > 10_000) { forced = true; schedule(0) } },
    /** A local save: the first one creates the vault, so pull now. */
    now: () => { forced = true; schedule(0) },
  }
}
async function account(): Promise<Account> {
  if (!PASSWORD_BETA_ENABLED || !native) throw unavailable()
  const ownerId = await native.account()
  if (!ownerId || !/^[a-f0-9-]{36}$/i.test(ownerId)) throw unavailable()
  if (current && current.ownerId !== ownerId) {
    const old = current; current = undefined; old.controller.abort(); old.login.invalidate(); old.saves.invalidate(); old.remote.invalidate(); await old.vault.dispose()
  }
  if (current) return current
  creating ??= createAccount(ownerId, native)
  try {
    current = await creating
    if (await native.account() !== ownerId) { current.controller.abort(); throw unavailable() }
    return current
  }
  finally { creating = undefined }
}
async function snapshot(value: Account): Promise<PasswordSnapshot> {
  let candidates: PasswordSnapshot['candidates'] = []
  try { candidates = passwordGrantCandidates(value.ownerId) } catch { candidates = [] }
  return { items: await value.vault.list(person), approvals: [...value.login.pending(), ...value.remote.pending()], outcomes: value.login.outcomes(), saves: value.saves.pending(), candidates, sync: value.sync.view() }
}
/** A dedicated native renderer IPC. Never uses generic action logging, transcript or device RPC. */
export function installPasswordBetaHost(host: NativeHost): void {
  if (!PASSWORD_BETA_ENABLED || native) return
  native = host
  ipcMain.handle(PASSWORD_UI_CHANNEL, async (event, command: PasswordUiCommand): Promise<PasswordUiReply> => {
    try {
      const window = host.window()
      if (!window || event.sender !== window.webContents || event.senderFrame !== event.sender.mainFrame) throw unavailable()
      const value = await account()
      switch (command?.type) {
        case 'snapshot': value.pull.soon(); break
        case 'save': {
          // Completing an Agent's request: a new credential stays writable by that Agent, nobody else gains access.
          const request = command.requestId ? value.saves.open(command.requestId).view : undefined
          if (request && request.credentialId !== command.reference?.id) throw unavailable()
          const creator: CredentialGrant | undefined = request && !command.reference ? { subject: `agent:${request.agent}`, level: 'write' } : undefined
          const saved = await value.vault.save(person, randomUUID(), { origin: command.origin, name: command.name, account: command.account, accountSecret: command.accountSecret,
            password: command.password, fields: (command.fields ?? []).map(field => ({ ...field, secret: field.secret ?? true })), sites: command.sites }, command.reference, creator)
          if (request) value.saves.complete(request.requestId, saved.reference.id)
          value.pull.now()
          break
        }
        case 'save-draft': return { ok: true, snapshot: await snapshot(value), draft: value.saves.draft(command.requestId) }
        case 'reject-save': value.saves.reject(command.requestId); break
        case 'delete': await value.vault.delete(person, randomUUID(), command.reference); break
        case 'reveal': return { ok: true, snapshot: await snapshot(value), secrets: await value.vault.reveal(person, command.reference) }
        case 'grants': await value.vault.setGrants(person, command.reference, command.grants); break
        case 'decide':
          if (!['allow_once', 'reject'].includes(command.decision)) throw unavailable()
          if (value.remote.has(command.requestId)) { if (command.remember || command.typed?.some(Boolean) || command.extra?.length) throw unavailable(); value.remote.decide(command.requestId, command.decision) }
          else value.login.decide(command.requestId, command.decision, command.typed, command.remember, command.secret, command.extra)
          break
        case 'sync-approve': await value.sync.approve(command.deviceId); break
        case 'sync-reject': await value.sync.reject(command.deviceId); break
        case 'sync-ask-again': await value.sync.askAgain(); break
        case 'sync-recovery-create': { const { code } = await value.sync.createRecovery(); changed(); return { ok: true, snapshot: await snapshot(value), recoveryCode: code } }
        case 'sync-recovery-remove': await value.sync.removeRecovery(); break
        case 'sync-recovery-skip': await value.sync.skipRecovery(); break
        case 'sync-recover': {
          let code: string
          try { ({ code } = await value.sync.recover(command.code)) }
          catch (error) { throw error instanceof SyncError && (error.code === 'INVALID' || error.code === 'NOT_MEMBER') ? new VaultError('RECOVERY_INVALID') : error }
          changed(); return { ok: true, snapshot: await snapshot(value), recoveryCode: code }
        }
        default: throw unavailable()
      }
      // Snapshot subscribers read here; broadcasting a read would recursively request another snapshot.
      if (command.type !== 'snapshot') changed()
      return { ok: true, snapshot: await snapshot(value) }
    } catch (error) {
      // No exception, message, cause, command or field is forwarded to any logger.
      return { ok: false, code: error instanceof VaultError ? error.code : error instanceof SyncError && error.code === 'STALE' ? 'STALE_REFERENCE' : 'UNAVAILABLE' }
    }
  })
  app.once('before-quit', () => { current?.controller.abort(); current?.login.invalidate(); current?.saves.invalidate(); current?.remote.invalidate(); void current?.vault.dispose().catch(() => {}) })
}
/**
 * An Agent's save (password_save), local or from a server. With write access on the credential it is saved at once,
 * unless it would turn a secret value non-secret or add a field without its value: only the person does those, so the
 * proposal goes to the person's form like one without access. Blank values keep the stored ones.
 */
async function agentSave(value: Account, caller: { agentId: string; sessionId: string }, subjects: string[], input: SaveProposal & { origin: string; credentialId?: string },
  context: GuguMcpContext | null, remote?: { agentName: string; sessionTitle: string; remote: string }) {
  const origin = httpsOrigin(input.origin)
  const item = input.credentialId ? (await value.vault.list(person)).find(entry => entry.reference.id === input.credentialId) : undefined
  if (input.credentialId && (!item || item.origin !== origin)) throw unavailable()
  const fields = planAgentSave(item, subjects, input, randomUUID)
  if (item && fields) {
    const saved = await value.vault.save(person, randomUUID(), { origin, name: input.name, account: input.account ?? '', accountSecret: input.accountSecret,
      password: input.password ?? '', fields }, item.reference)
    changed()
    return { status: 'saved' as const, credentialId: saved.reference.id }
  }
  const { requestId, status } = await value.saves.request(context, caller, origin, item, input, remote)
  return { requestId, status }
}
async function caller(context: GuguMcpContext) {
  const value = await account(), identity = passwordNativeMcpIdentity(context)
  if (!identity || identity.ownerId !== value.ownerId) throw unavailable()
  return { value, identity, subjects: passwordGrantSubjects(value.ownerId, identity.subjectId, identity.sessionId) }
}
/** Agent surface returns metadata/status only. No person evidence or secret-bearing command exists. */
export const passwordBetaAgent = Object.freeze({
  async start(context: GuguMcpContext, requestId: string) { return (await account()).login.start(context, requestId) },
  async list(context: GuguMcpContext, search: CredentialSearch = {}) {
    const { value, subjects } = await caller(context)
    return searchCredentials((await value.vault.list(person)).map(item => agentCredential(item, subjects)), search)
  },
  async request(context: GuguMcpContext, signal: AbortSignal, input: FillInput) {
    const { value, subjects } = await caller(context)
    const items = await value.vault.list(person)
    let item = input.credentialId ? items.find(entry => entry.reference.id === input.credentialId) : undefined
    if (input.credentialId && !item) throw unavailable()
    if (!item) {
      // The page's website picks it: the only one saved for it, or the only one of those usable without asking.
      let origin: string
      try { origin = httpsOrigin(new URL(input.url).origin) } catch { return { status: 'invalid_request', retry: false, error: 'url must be an https page.' } }
      const here = items.filter(entry => entry.origin === origin || entry.sites.includes(origin))
      const usable = here.filter(entry => passwordGrantLevel(entry.grants, subjects))
      item = here.length === 1 ? here[0] : usable.length === 1 ? usable[0] : undefined
      // Several saved: the Agent picks. None: the person fills the values in on the card.
      if (!item && here.length) return { status: 'choose', retry: false, candidates: searchCredentials(here.map(entry => agentCredential(entry, subjects))).items }
    }
    return value.login.request(context, signal, item, input)
  },
  async status(context: GuguMcpContext, requestId: string) {
    const { value, identity } = await caller(context)
    return { status: value.login.status(requestId, identity.sessionId) }
  },
  /** 可写 on that credential: saved at once (blank keeps the stored value). Otherwise the person fills it in from a private message. */
  async save(context: GuguMcpContext, input: SaveProposal & { origin: string; credentialId?: string }) {
    const { value, identity, subjects } = await caller(context)
    return agentSave(value, { agentId: identity.subjectId, sessionId: identity.sessionId }, subjects, input, context)
  },
  async saveStatus(context: GuguMcpContext, requestId: string) {
    const { value, identity } = await caller(context)
    return value.saves.status(requestId, identity.sessionId)
  },
})

/**
 * 「本机送」(server-delivery.ts): the account's servers ask this desktop. Same account only (the device RPC carries the
 * asker's user id); grants name the Agent (`agent:<id>`), the same id on every machine. Project grants name projects of
 * this computer and do not reach a server's sessions. Errors are one fixed code, never a lower-layer message.
 */
export function passwordBetaRemoteHandlers() {
  const fail = () => ({ error: { code: 'PASSWORD_UNAVAILABLE', message: 'Password vault unavailable' } })
  return {
    [PASSWORD_AGENT_RPC]: async (payload: unknown, ctx: { request: { user_id: string } }) => {
      try {
        if (!PASSWORD_BETA_ENABLED) return fail()
        const op = remoteOpSchema.parse(payload), value = await account()
        if (ctx.request.user_id !== value.ownerId) return fail()
        const caller: RemoteCaller = op.caller, subjects = [`agent:${caller.agentId}`]
        const items = () => value.vault.list(person)
        switch (op.op) {
          case 'list': return { result: (await items()).map(item => agentCredential(item, subjects)) }
          case 'request': {
            const item = (await items()).find(entry => entry.reference.id === op.credentialId)
            if (!item || item.origin !== httpsOrigin(op.origin)) return fail()
            return { result: value.remote.request(caller, item, !!passwordGrantLevel(item.grants, subjects)) }
          }
          case 'status': return { result: { status: value.remote.status(op.requestId, caller) } }
          case 'release': return { result: { sealed: await value.remote.release(op.requestId, caller, item =>
            value.vault.releaseToServer(item.reference, plain => sealTo(op.serverKey, plain), { agentId: caller.agentId, sessionId: caller.sessionId, requestId: op.requestId })) } }
          case 'save': {
            const { op: _op, caller: _caller, ...input } = op
            // The server posts the card from its own session; this desktop keeps the proposal for the person's form.
            return { result: await agentSave(value, { agentId: caller.agentId, sessionId: caller.sessionId }, subjects, input, null,
              { agentName: caller.agentName, sessionTitle: caller.sessionTitle, remote: caller.deviceId }) }
          }
          case 'saveStatus': return { result: value.saves.status(op.requestId, caller.sessionId) }
        }
      } catch { return fail() }
    },
  }
}
