import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { syncDirectory } from '../../../../apps/desktop/electron/password-vault/sync'
import { eraseClosedAccountPasswordData } from '../../../../apps/desktop/electron/account-closure/password-data'

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { force: true, recursive: true }) })
describe('native closed-account password directories', () => {
  it('removes the actual vault and sync key roots for A, including temporary writes, while preserving B', async () => {
    const root = await mkdtemp(join(tmpdir(), 'closure-password-data-')); roots.push(root)
    for (const owner of [A, B]) {
      await mkdir(join(root, owner), { recursive: true }); await writeFile(join(root, owner, 'vault'), owner)
      await mkdir(syncDirectory(root, owner), { recursive: true })
      await writeFile(join(syncDirectory(root, owner), 'sync-device.json'), owner)
      await writeFile(join(syncDirectory(root, owner), 'sync-device.json.interrupted.tmp'), owner)
    }
    await eraseClosedAccountPasswordData(root, A)
    for (const file of [join(root, A, 'vault'), join(syncDirectory(root, A), 'sync-device.json'), join(syncDirectory(root, A), 'sync-device.json.interrupted.tmp')])
      await expect(readFile(file)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(join(root, B, 'vault'), 'utf8')).toBe(B)
    expect(await readFile(join(syncDirectory(root, B), 'sync-device.json'), 'utf8')).toBe(B)
    await eraseClosedAccountPasswordData(root, A)
  })
  it('refuses an alias in the sync account root and does not erase its B target', async () => {
    const root = await mkdtemp(join(tmpdir(), 'closure-password-alias-')); roots.push(root)
    await mkdir(syncDirectory(root, B), { recursive: true }); await writeFile(join(syncDirectory(root, B), 'key'), 'B')
    await symlink(syncDirectory(root, B), syncDirectory(root, A), 'dir')
    await expect(eraseClosedAccountPasswordData(root, A)).rejects.toThrow('alias')
    expect(await readFile(join(syncDirectory(root, B), 'key'), 'utf8')).toBe('B')
  })
})
