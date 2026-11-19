import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { lstat, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes, randomUUID } from 'node:crypto'
import type { VaultKeyProtector } from '../../../apps/desktop/electron/password-vault/contracts'
import { seal, unseal } from '../../../apps/desktop/electron/password-vault/crypto'
import { createDesktopClosureService } from '../../../apps/desktop/electron/account-closure/service'
import { eraseClosedAccountPasswordData } from '../../../apps/desktop/electron/account-closure/password-data'
import { privatePasswordVaultDirectory } from '@gugu/core/local/state/protectedPrivateStorage'
import { syncDirectory } from '../../../apps/desktop/electron/password-vault/sync'
import { LocalPasswordVault } from '../../../apps/desktop/electron/password-vault/service'

const h = vi.hoisted(() => ({ root: '', handlers: new Map<string, (event: unknown, command: unknown) => Promise<unknown>>(), keys: undefined as unknown as VaultKeyProtector }))
vi.mock('electron', () => ({ app: { getPath: () => h.root, once() {} }, ipcMain: { handle: (name: string, callback: (event: unknown, command: unknown) => Promise<unknown>) => h.handlers.set(name, callback) } }))
vi.mock('../../../apps/desktop/electron/password-vault/mac', () => ({ macVaultKeyProtector: () => h.keys }))
vi.mock('@gugu/core/shared/passwordBeta', async original => ({ ...await original<typeof import('@gugu/core/shared/passwordBeta')>(), PASSWORD_BETA_ENABLED: true }))
vi.mock('@gugu/core/local/state/agentFileBoundary', async original => ({ ...await original<typeof import('@gugu/core/local/state/agentFileBoundary')>(), protectedPrivateStorageStatus: async () => ({ status: 'ready' }) }))
vi.mock('../../../apps/desktop/electron/permissions/password-beta-access', () => ({ createBetaPasswordAccess: (options: { signal: AbortSignal }) => ({
  acquireFeatureGuard: async () => ({ status: 'ready', signal: options.signal, assertCurrent: () => options.signal.throwIfAborted() }),
}) }))
vi.mock('../../../apps/desktop/electron/session/main/core/sessions/password-beta-presentation', () => ({
  passwordGrantCandidates: async () => [], passwordGrantSubjects: () => [], passwordRequestPresentation: () => ({}),
}))
import { closePasswordVaultForAccountClosure, installPasswordBetaHost, PASSWORD_UI_CHANNEL } from '../../../apps/desktop/electron/password-vault/beta-host'

const owners: string[] = [], releases: Array<() => void> = []
const mainFrame = {}, webContents = { mainFrame, send() {} }
let currentHost: { owner(): string; rpc(): Promise<unknown> }
beforeEach(async () => {
  h.root = await mkdtemp(join(await realpath(tmpdir()), 'beta-host-closure-'))
  vi.stubEnv('GUGU_HOME', h.root)
  const key = randomBytes(32)
  h.keys = { verifyPerson: async () => {}, wrap: async (bytes, binding) => JSON.stringify(seal(key, bytes, binding)),
    unwrap: async (wrapped, binding) => unseal(key, JSON.parse(wrapped), binding) }
})
afterEach(async () => {
  for (const release of releases.splice(0)) release()
  for (const owner of owners.splice(0)) await closePasswordVaultForAccountClosure(owner)
  await rm(h.root, { force: true, recursive: true }); vi.unstubAllEnvs(); vi.restoreAllMocks()
})
function host() {
  let owner = randomUUID(); owners.push(owner)
  const entered = new Map<string, ReturnType<typeof Promise.withResolvers<void>>>(), held = new Map<string, ReturnType<typeof Promise.withResolvers<unknown>>>()
  currentHost = { owner: () => owner, rpc: async () => {
    const actual = owner
    entered.get(actual)?.resolve()
    return held.get(actual)?.promise ?? { initialized: false }
  } }
  installPasswordBetaHost({ window: () => ({ webContents, isDestroyed: () => false }) as never,
    account: async () => currentHost.owner(), device: () => 'controlled-device', deliver: async () => {}, deliverSave: async () => {},
    readPolicy: async () => ({}) as never, verifyOwner: async () => {}, presence: () => 'active', notify() {},
    rpc: () => currentHost.rpc() })
  const block = (id: string) => {
    const start = Promise.withResolvers<void>(), pending = Promise.withResolvers<unknown>(); entered.set(id, start); held.set(id, pending)
    releases.push(() => pending.resolve({ initialized: false }))
    return { entered: start.promise, release: () => pending.resolve({ initialized: false }) }
  }
  const snapshot = () => h.handlers.get(PASSWORD_UI_CHANNEL)!({ sender: webContents, senderFrame: mainFrame }, { type: 'snapshot' })
  const save = () => h.handlers.get(PASSWORD_UI_CHANNEL)!({ sender: webContents, senderFrame: mainFrame },
    { type: 'save', origin: 'https://controlled.invalid', account: 'controlled', password: 'controlled', fields: [], sites: [] })
  return { owner: () => owner, block, snapshot, save, switchToB: () => { owner = randomUUID(); owners.push(owner); return owner } }
}
describe('real beta-host disposal hook in native owner cleanup', () => {
  it('keeps native erase pending for the original host sync IO and then erases both real A roots', async () => {
    const f = host(), A = f.owner(), blocked = f.block(A)
    expect(await f.snapshot()).toMatchObject({ ok: true }); await blocked.entered
    expect(await f.save()).toMatchObject({ ok: true })
    await new Promise(resolve => setTimeout(resolve, 0))
    const disposed = vi.spyOn(LocalPasswordVault.prototype, 'dispose')
    const secrets = new Map<string, string>(), scope = { ownerId: A, localOperationId: 'controlled' }
    const native = createDesktopClosureService({ profileBinding: h.root, currentOwner: async () => A,
      secrets: { getSecret: async key => secrets.get(key) ?? null, setSecret: async (key, value) => { secrets.set(key, value) } },
      stopOwner: async () => {}, steps: [{ name: 'password-data', run: async () => {
        await closePasswordVaultForAccountClosure(A); await eraseClosedAccountPasswordData(privatePasswordVaultDirectory(), A); return true
      } }], retained: async () => [] })
    await native.native.receipt.put(scope, 'controlled'); await native.prepare(scope)
    let erased = false
    const erasing = native.native.eraseLocal(scope).then(value => { erased = true; return value })
    await new Promise(resolve => setImmediate(resolve)); expect(erased).toBe(false); expect(disposed).not.toHaveBeenCalled()
    expect(await readFile(join(syncDirectory(privatePasswordVaultDirectory(), A), 'sync-device.json'), 'utf8')).toContain('controlled-device')
    blocked.release(); expect(await erasing).toMatchObject({ status: 'complete' })
    for (const path of [join(privatePasswordVaultDirectory(), A), syncDirectory(privatePasswordVaultDirectory(), A)])
      await expect(lstat(path)).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('closing an old A account does not wait for or abort B real host sync', async () => {
    const f = host(), A = f.owner(), a = f.block(A)
    expect(await f.snapshot()).toMatchObject({ ok: true }); await a.entered; a.release()
    const B = f.switchToB(), b = f.block(B)
    expect(await f.snapshot()).toMatchObject({ ok: true }); await b.entered
    await closePasswordVaultForAccountClosure(A)
    expect(await f.snapshot()).toMatchObject({ ok: true })
    expect(await readFile(join(syncDirectory(privatePasswordVaultDirectory(), B), 'sync-device.json'), 'utf8')).toContain('controlled-device')
    b.release(); await closePasswordVaultForAccountClosure(B)
  })
})
