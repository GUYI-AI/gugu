import { app, ipcMain, type BrowserWindow } from 'electron'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { PASSWORD_BETA_ENABLED } from '@gugu/core/shared/passwordBeta'
import { passwordGrantLevel, type PasswordItem, type PasswordUiCommand, type PasswordUiReply, type PasswordSnapshot } from '@gugu/core/shared/passwordBetaProtocol'
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

export const PASSWORD_UI_CHANNEL = 'gugu:password-beta-ui'
export const PASSWORD_CHANGED_CHANNEL = 'gugu:password-beta-changed'
interface NativeHost { window(): BrowserWindow | null; account(): Promise<string | null>; device(): string | null | Promise<string | null>;
  deliver(sessionId: string, requestId: string, status: string): Promise<void>;
  deliverSave(sessionId: string, requestId: string, status: SaveResult, credentialId?: string): Promise<void>;
  readPolicy(ownerId: string, signal: AbortSignal): Promise<PermissionPolicy>
  /** System owner verification (Touch ID or login password) through the native helper. */
  verifyOwner(reason: string): Promise<void>
  /** Signed-in identity-schema RPC for vault sync; throws the backend error (with its SQLSTATE `code`). */
  rpc(name: string, args: Record<string, unknown>): Promise<unknown> }
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
    subjects: (agentId, sessionId) => passwordGrantSubjects(ownerId, agentId, sessionId), denied: () => false, deliver: host.deliver })
  const saves = new BetaPasswordSaves({ deviceId, changed, describe, deliver: host.deliverSave })
  const keys = macVaultKeyProtector(reason => host.verifyOwner(reason))
  // The vault publishes through this port before each local commit; the engine exists once the vault does.
  const port: { sync?: VaultSync } = {}
  const { vault } = createVaultStorage({ root, accountId: ownerId, installationBinding: app.getPath('userData'),
    sync: { publish: change => port.sync ? port.sync.publish(change) : Promise.resolve() },
    assertLocalPerson: value => { assertCurrent(); if (value !== person) throw unavailable() },
    assertOwnedLocalAgent: value => { assertCurrent(); if (value !== person) throw unavailable() },
    assertPrivateStorageReady: protection, keys,
    invalidate: async () => { login.invalidate() },
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
  return { ownerId, vault, login, saves, controller, assertCurrent, sync, pull: pulling(sync, controller.signal) }
}
/** Pull every minute, every few seconds while a device is joining or a code is being compared, and soon after the
 * settings page asks (at most every 10 seconds). Failures wait for the next pull; nothing is shown for them. */
function pulling(sync: VaultSync, signal: AbortSignal) {
  let timer: ReturnType<typeof setTimeout> | undefined, last = 0, running = false
  const urgent = () => {
    const view = sync.view()
    return view.state === 'joining' || view.state === 'ready' && view.requests.some(request => request.stage === 'waiting' || request.stage === 'compare')
  }
  const run = async () => {
    if (signal.aborted || running) return
    running = true; last = Date.now()
    try { await sync.refresh() } catch { /* offline or not signed in: the next pull retries */ }
    finally { running = false; schedule(urgent() ? 3_000 : 60_000) }
  }
  const schedule = (delay: number) => {
    if (signal.aborted) return
    clearTimeout(timer); timer = setTimeout(() => void run(), delay); timer.unref?.()
  }
  signal.addEventListener('abort', () => { clearTimeout(timer); sync.dispose() }, { once: true })
  schedule(0)
  return { soon: () => { if (Date.now() - last > 10_000) schedule(0) } }
}
async function account(): Promise<Account> {
  if (!PASSWORD_BETA_ENABLED || !native) throw unavailable()
  const ownerId = await native.account()
  if (!ownerId || !/^[a-f0-9-]{36}$/i.test(ownerId)) throw unavailable()
  if (current && current.ownerId !== ownerId) {
    const old = current; current = undefined; old.controller.abort(); old.login.invalidate(); old.saves.invalidate(); await old.vault.dispose()
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
  return { items: await value.vault.list(person), approvals: value.login.pending(), saves: value.saves.pending(), candidates, sync: value.sync.view() }
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
          const saved = await value.vault.save(person, randomUUID(), { origin: command.origin, account: command.account, password: command.password, fields: command.fields ?? [] }, command.reference, creator)
          if (request) value.saves.complete(request.requestId, saved.reference.id)
          break
        }
        case 'save-draft': return { ok: true, snapshot: await snapshot(value), draft: value.saves.draft(command.requestId) }
        case 'reject-save': value.saves.reject(command.requestId); break
        case 'delete': await value.vault.delete(person, randomUUID(), command.reference); break
        case 'reveal': return { ok: true, snapshot: await snapshot(value), secrets: await value.vault.reveal(person, command.reference) }
        case 'grants': await value.vault.setGrants(person, command.reference, command.grants); break
        case 'decide': value.login.decide(command.requestId, command.decision); break
        case 'sync-open': await value.sync.challenge(command.deviceId); break
        case 'sync-approve': await value.sync.approve(command.deviceId); break
        case 'sync-reject': await value.sync.reject(command.deviceId); break
        case 'sync-remove': await value.sync.remove(command.deviceId); break
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
  app.once('before-quit', () => { current?.controller.abort(); current?.login.invalidate(); current?.saves.invalidate(); void current?.vault.dispose().catch(() => {}) })
}
/** What an Agent sees of one credential: never a value, and only its own access level. */
function agentView(item: PasswordItem, subjects: string[]) {
  return { credentialId: item.reference.id, origin: item.origin, maskedAccount: item.maskedAccount, fields: item.fields.map(field => field.name),
    access: passwordGrantLevel(item.grants, subjects) ?? 'ask' }
}
async function caller(context: GuguMcpContext) {
  const value = await account(), identity = passwordNativeMcpIdentity(context)
  if (!identity || identity.ownerId !== value.ownerId) throw unavailable()
  return { value, identity, subjects: passwordGrantSubjects(value.ownerId, identity.subjectId, identity.sessionId) }
}
/** Agent surface returns metadata/status only. No person evidence or secret-bearing command exists. */
export const passwordBetaAgent = Object.freeze({
  async start(context: GuguMcpContext, requestId: string) { return (await account()).login.start(context, requestId) },
  async list(context: GuguMcpContext) {
    const { value, subjects } = await caller(context)
    return (await value.vault.list(person)).map(item => agentView(item, subjects))
  },
  async request(context: GuguMcpContext, signal: AbortSignal, input: {
    credentialId: string; browserId: string; loginUrl: string; selection: { form: string; account: string; password: string; submitter?: string }
  }) {
    const { value } = await caller(context)
    const item = (await value.vault.list(person)).find(item => item.reference.id === input.credentialId)
    if (!item) throw unavailable()
    return value.login.request(context, signal, item, input)
  },
  async status(context: GuguMcpContext, requestId: string) {
    const { value, identity } = await caller(context)
    return { status: value.login.status(requestId, identity.sessionId) }
  },
  /** 可写 on that credential: saved at once (blank keeps the stored value). Otherwise the person fills it in from a private message. */
  async save(context: GuguMcpContext, input: SaveProposal & { origin: string; credentialId?: string }) {
    const { value, identity, subjects } = await caller(context)
    let origin: string
    try { origin = httpsOrigin(input.origin) } catch { throw unavailable() }
    const item = input.credentialId ? (await value.vault.list(person)).find(entry => entry.reference.id === input.credentialId) : undefined
    if (input.credentialId && (!item || item.origin !== origin)) throw unavailable()
    if (item && passwordGrantLevel(item.grants, subjects) === 'write') {
      const named = new Map((input.fields ?? []).map(field => [field.name, field.value]))
      // Fields the Agent did not mention keep their stored value (blank); new names become new fields.
      const fields = [...item.fields.map(field => ({ id: field.id, name: field.name, value: named.get(field.name) ?? '' })),
        ...[...named].filter(([name]) => !item.fields.some(field => field.name === name)).map(([name, text]) => ({ id: randomUUID(), name, value: text }))]
      const saved = await value.vault.save(person, randomUUID(), { origin, account: input.account ?? '', password: input.password ?? '', fields }, item.reference)
      changed()
      return { status: 'saved', credentialId: saved.reference.id }
    }
    return value.saves.request(context, { agentId: identity.subjectId, sessionId: identity.sessionId }, origin, item, input)
  },
  async saveStatus(context: GuguMcpContext, requestId: string) {
    const { value, identity } = await caller(context)
    return value.saves.status(requestId, identity.sessionId)
  },
})
