import { app, ipcMain, type BrowserWindow } from 'electron'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { PASSWORD_BETA_ENABLED } from '@gugu/core/shared/passwordBeta'
import type { PasswordUiCommand, PasswordUiReply, PasswordSnapshot } from '@gugu/core/shared/passwordBetaProtocol'
import { privatePasswordVaultDirectory, PASSWORD_VAULT_STORAGE } from '@gugu/core/local/state/protectedPrivateStorage'
import { protectedPrivateStorageStatus } from '@gugu/core/local/state/agentFileBoundary'
import { createBetaPasswordAccess } from '../permissions/password-beta-access'
import type { PermissionPolicy } from '../permissions/rules'
import { guguMcpToolScope, passwordNativeMcpIdentity } from '../mcp/password-native-identity'
import type { GuguMcpContext } from '../acp-engine-utils'
import { createVaultStorage } from './host'
import { macVaultKeyProtector } from './mac'
import { VaultError } from './contracts'
import { passwordRequestPresentation } from '../session/main/core/sessions/password-beta-presentation'
import { BetaPasswordLogin } from './beta-login'

export const PASSWORD_UI_CHANNEL = 'gugu:password-beta-ui'
export const PASSWORD_CHANGED_CHANNEL = 'gugu:password-beta-changed'
interface NativeHost { window(): BrowserWindow | null; account(): Promise<string | null>; device(): string | null | Promise<string | null>;
  deliver(sessionId: string, requestId: string, status: string): Promise<void>;
  readPolicy(ownerId: string, signal: AbortSignal): Promise<PermissionPolicy> }
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
  const preferences = join(privatePasswordVaultDirectory(), 'beta-preferences', `${ownerId}.json`)
  let denied = false
  const assertCurrent = () => { controller.signal.throwIfAborted(); if (current && current.ownerId !== ownerId) throw unavailable() }
  const protection = async () => { if ((await protectedPrivateStorageStatus(PASSWORD_VAULT_STORAGE)).status !== 'ready') throw unavailable() }
  await protection()
  try {
    const value: unknown = JSON.parse(await readFile(preferences, 'utf8'))
    if (!value || typeof value !== 'object' || !('denied' in value) || typeof value.denied !== 'boolean') throw unavailable()
    denied = value.denied
  } catch (error) {
    // An absent preference defaults to asking. Unreadable/corrupt saved denials never become permission.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw unavailable()
  }
  const access = createBetaPasswordAccess({ signal: controller.signal, toolScope: guguMcpToolScope,
    readPolicy: async (owner, signal) => {
      if (await host.account() !== ownerId || owner !== ownerId || denied) throw unavailable()
      assertCurrent()
      return host.readPolicy(owner, signal)
    } })
  const deviceId = await host.device()
  if (!deviceId) throw unavailable()
  const login = new BetaPasswordLogin({ ownerId, deviceId, signal: controller.signal,
    access, assertCurrent, changed, describe: (agentId, sessionId) => passwordRequestPresentation(ownerId, agentId, sessionId), denied: () => denied, deliver: host.deliver })
  const { vault } = createVaultStorage({ root, accountId: ownerId, installationBinding: app.getPath('userData'),
    assertLocalPerson: value => { assertCurrent(); if (value !== person) throw unavailable() },
    assertOwnedLocalAgent: value => { assertCurrent(); if (value !== person) throw unavailable() },
    assertPrivateStorageReady: protection, keys: macVaultKeyProtector(),
    invalidate: async () => { login.invalidate() },
  }, login.sink, async (operation, signal) => {
    if (!PASSWORD_BETA_ENABLED || await host.account() !== ownerId) throw unavailable()
    const result = await access.acquireFeatureGuard(operation, signal)
    if (result.status !== 'ready') throw unavailable()
    return result
  })
  login.bindVault(vault)
  return { ownerId, vault, login, controller, assertCurrent,
    denied: () => denied,
    setDenied: async (value: boolean) => {
      await protection(); assertCurrent()
      await mkdir(join(privatePasswordVaultDirectory(), 'beta-preferences'), { recursive: true, mode: 0o700 })
      await writeFile(preferences, JSON.stringify({ denied: value }), { mode: 0o600 })
      denied = value
      if (value) login.invalidate()
    },
  }
}
async function account(): Promise<Account> {
  if (!PASSWORD_BETA_ENABLED || !native) throw unavailable()
  const ownerId = await native.account()
  if (!ownerId || !/^[a-f0-9-]{36}$/i.test(ownerId)) throw unavailable()
  if (current && current.ownerId !== ownerId) {
    const old = current; current = undefined; old.controller.abort(); old.login.invalidate(); await old.vault.dispose()
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
  const state = value.vault.state()
  return { status: state.status, initialized: await value.vault.isInitialized(person), denied: value.denied(),
    items: state.status === 'unlocked' ? await value.vault.list(person) : [], approvals: value.login.pending() }
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
        case 'snapshot': break
        case 'unlock': await value.vault.unlock(person); break
        case 'lock': await value.vault.lock(); break
        case 'begin-setup': return { ok: true, snapshot: await snapshot(value), setup: await value.vault.beginSetup(person) }
        case 'confirm-setup': await value.vault.confirmRecovery(person, command.setupId, command.material); break
        case 'save': await value.vault.save(person, randomUUID(), { origin: command.origin, account: command.account, password: command.password }); break
        case 'delete': await value.vault.delete(person, randomUUID(), command.reference); break
        case 'deny': if (typeof command.value !== 'boolean') throw unavailable(); await value.setDenied(command.value); break
        case 'decide': value.login.decide(command.requestId, command.decision); break
        default: throw unavailable()
      }
      // Snapshot subscribers read here; broadcasting a read would recursively request another snapshot.
      if (command.type !== 'snapshot') changed()
      return { ok: true, snapshot: await snapshot(value) }
    } catch (error) {
      // No exception, message, cause, command or field is forwarded to any logger.
      return { ok: false, code: error instanceof VaultError ? error.code : 'UNAVAILABLE' }
    }
  })
  app.once('before-quit', () => { current?.controller.abort(); current?.login.invalidate(); void current?.vault.dispose().catch(() => {}) })
}
/** Agent surface returns metadata/status only. No person evidence or secret-bearing command exists. */
export const passwordBetaAgent = Object.freeze({
  async start(context: GuguMcpContext, requestId: string) { return (await account()).login.start(context, requestId) },
  async list(context: GuguMcpContext) {
    const value = await account(), identity = passwordNativeMcpIdentity(context)
    if (!identity || identity.ownerId !== value.ownerId || value.denied()) throw unavailable()
    return value.vault.list(person)
  },
  async request(context: GuguMcpContext, signal: AbortSignal, input: {
    credentialId: string; browserId: string; loginUrl: string; selection: { form: string; account: string; password: string; submitter?: string }
  }) {
    const value = await account(), identity = passwordNativeMcpIdentity(context)
    if (!identity || identity.ownerId !== value.ownerId) throw unavailable()
    const item = (await value.vault.list(person)).find(item => item.reference.id === input.credentialId)
    if (!item) throw unavailable()
    return value.login.request(context, signal, item, input)
  },
  async status(context: GuguMcpContext, requestId: string) {
    const value = await account(), identity = passwordNativeMcpIdentity(context)
    if (!identity || identity.ownerId !== value.ownerId) throw unavailable()
    return { status: value.login.status(requestId, identity.sessionId) }
  },
})
