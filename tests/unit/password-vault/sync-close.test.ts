import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { VaultSync, syncDirectory } from '../../../apps/desktop/electron/password-vault/sync'
import { seal, unseal } from '../../../apps/desktop/electron/password-vault/crypto'
import { eraseClosedAccountPasswordData } from '../../../apps/desktop/electron/account-closure/password-data'

const io = vi.hoisted(() => ({ beforeWrite: undefined as undefined | ((path: string) => Promise<void>) }))
vi.mock('node:fs/promises', async original => {
  const real = await original<typeof import('node:fs/promises')>()
  return { ...real, writeFile: async (...args: Parameters<typeof real.writeFile>) => {
    await io.beforeWrite?.(String(args[0])); return real.writeFile(...args)
  } }
})
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const roots: string[] = []
afterEach(async () => { io.beforeWrite = undefined; for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function fixture(rpc: (name: string) => Promise<unknown>) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'closure-sync-')); roots.push(root)
  const key = randomBytes(32)
  const sync = new VaultSync({ root: syncDirectory(root, A), ownerId: A, deviceId: 'fixture-device', changed() {}, rpc,
    keys: { verifyPerson: async () => {}, wrap: async (bytes, binding) => JSON.stringify(seal(key, bytes, binding)),
      unwrap: async (wrapped, binding) => unseal(key, JSON.parse(wrapped), binding) },
    vault: { syncExport: async () => [], syncApply: async () => {} } })
  return { sync, root, file: join(syncDirectory(root, A), 'sync-device.json') }
}
describe('VaultSync actual operation and write-queue shutdown', () => {
  it('waits for an admitted atomic device-file write before owner erasure, and cannot recreate it afterward', async () => {
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
    const rpc = vi.fn(async () => '0'), f = await fixture(rpc)
    io.beforeWrite = async path => { if (path.startsWith(f.file + '.')) { entered.resolve(); await release.promise } }
    const polling = f.sync.poll().catch(error => error)
    await entered.promise
    let closed = false
    const closing = f.sync.close().then(() => { closed = true })
    await Promise.resolve(); expect(closed).toBe(false)
    release.resolve(); await polling; await closing
    expect(await readFile(f.file, 'utf8')).toContain('fixture-device')
    expect(rpc).not.toHaveBeenCalled()
    await eraseClosedAccountPasswordData(f.root, A)
    await expect(f.sync.poll()).rejects.toMatchObject({ code: 'UNAVAILABLE' })
    await expect(readFile(f.file)).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('drains the admitted serialized refresh and refuses queued UI work after sealing', async () => {
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<unknown>()
    const rpc = vi.fn(async () => { entered.resolve(); return release.promise }), f = await fixture(rpc)
    const refreshing = f.sync.refresh().catch(error => error)
    await entered.promise
    const queued = f.sync.skipRecovery().catch(error => error)
    let closed = false
    const closing = f.sync.close().then(() => { closed = true })
    await Promise.resolve(); expect(closed).toBe(false)
    release.resolve({ initialized: false }); await refreshing; await queued; await closing
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(closed).toBe(true)
    await expect(f.sync.refresh()).rejects.toMatchObject({ code: 'UNAVAILABLE' })
  })
})
