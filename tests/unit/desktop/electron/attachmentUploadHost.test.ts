import { mkdtemp, chmod, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { attachmentSha256 } from '@gugu/core/cloud/attachmentsApi'
import { storeBytes, storedCopy } from '@gugu/core/local/files/fileSnapshots'
const hosts = vi.hoisted(() => [] as import('@gugu/core/cloud/declaredUploads').DeclaredUploadHost[])
const queues = vi.hoisted(() => [] as { begin: ReturnType<typeof vi.fn>; resume: ReturnType<typeof vi.fn>; drop: ReturnType<typeof vi.fn>; retry: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> }[])
vi.mock('@gugu/core/cloud/declaredUploads', () => ({ createDeclaredUploads: (host: import('@gugu/core/cloud/declaredUploads').DeclaredUploadHost) => {
  hosts.push(host)
  const queue = { begin: vi.fn().mockResolvedValue(undefined), resume: vi.fn().mockResolvedValue(undefined), drop: vi.fn(), retry: vi.fn().mockResolvedValue(undefined), dispose: vi.fn() }
  queues.push(queue); return queue
} }))
import { createAttachmentUploadHost } from '../../../../apps/desktop/electron/attachmentUploadHost'
const roots: string[] = []
afterEach(async () => {
  hosts.length = 0; queues.length = 0
  for (const root of roots.splice(0)) {
    if (!root.startsWith(join(tmpdir(), 'declared-upload-host-'))) throw Error('Foreign fixture')
    await rm(root, { recursive: true, force: true })
  }
})
it('stores verified original bytes before declaring, resumes only from that store, and forwards progress/drop/retry', async () => {
  const home = await mkdtemp(join(tmpdir(), 'declared-upload-host-')); roots.push(home)
  const bytes = new Blob(['original']), sha256 = await attachmentSha256(bytes)
  const fetcher = vi.fn(async () => {
    expect(await (await storedCopy(home, sha256))?.text()).toBe('original')
    return new Response(JSON.stringify({ staging_key: 'pending', url: 'https://store.test', fields: {}, max_bytes: 100 }), { status: 200 })
  })
  const progress = vi.fn(), host = createAttachmentUploadHost({ account: async () => ({ id: 'owner', home, endpoint: async () => ({ supabaseUrl: 'https://db.test', anonKey: 'a', token: 't', fetch: fetcher }) }), progress, warn: error => { throw error } })
  const declared = await host.declare({ file: { name: 'file.txt', path: '', data: await bytes.arrayBuffer(), size: bytes.size, contentType: 'text/plain' }, chatId: 'chat', as: 'owner', messageId: 'm' })
  expect(declared).toEqual({ staging_key: 'pending', sha256, size_bytes: bytes.size })
  expect(queues[0]!.begin).toHaveBeenCalledOnce()
  expect(await (queues[0]!.begin.mock.calls[0]![1] as Blob).text()).toBe('original')
  expect(await (await hosts[0]!.copyOf(sha256))?.text()).toBe('original')
  expect(await hosts[0]!.copyOf('f'.repeat(64))).toBeNull()
  hosts[0]!.progress('m', { sha256, loaded: 2, total: 8, attempt: 1 })
  expect(progress).toHaveBeenLastCalledWith({ messageId: 'm', sha256, loaded: 2, total: 8, attempt: 1 })
  await host.resume(); await host.retry('m'); await host.drop('m')
  expect(queues[0]!.resume).toHaveBeenCalledOnce(); expect(queues[0]!.retry).toHaveBeenCalledWith('m'); expect(queues[0]!.drop).toHaveBeenCalledWith('m')
  host.dispose(); expect(queues[0]!.dispose).toHaveBeenCalledOnce()
})
it('a stored sha is reused; corrupted bytes cannot resume and replacements are verified before publication', async () => {
  const home = await mkdtemp(join(tmpdir(), 'declared-upload-host-')); roots.push(home)
  const bytes = new Blob(['bytes']), sha = createHash('sha256').update('bytes').digest('hex')
  await storeBytes(home, sha, 'first.txt', bytes); await storeBytes(home, sha, 'other.txt', bytes)
  const directory = join(home, 'file-store', sha)
  expect(await readdir(directory)).toEqual(['first.txt'])
  const file = join(directory, 'first.txt')
  await chmod(file, 0o600); await writeFile(file, 'wrong')
  expect(await storedCopy(home, sha)).toBeNull()
  await expect(storeBytes(home, sha, 'bad.txt', new Blob(['wrong']))).rejects.toThrow()
  const [aside] = await readdir(join(home, 'file-store', '.changed'))
  expect(await readFile(join(home, 'file-store', '.changed', aside!, 'first.txt'), 'utf8')).toBe('wrong')
  await storeBytes(home, sha, 'first.txt', bytes)
  expect(await (await storedCopy(home, sha))?.text()).toBe('bytes')
})
it('switching accounts disposes the old queue and cannot use its endpoint', async () => {
  let id: string | null = 'one'
  const host = createAttachmentUploadHost({ account: async () => id ? ({ id, home: '/unused', endpoint: async () => ({ supabaseUrl: 'https://db.test', anonKey: 'a', token: 't' }) }) : null, progress: vi.fn(), warn: vi.fn() })
  await host.resume(); id = 'two'; await host.resume()
  expect(queues[0]!.dispose).toHaveBeenCalledOnce()
  await expect(hosts[0]!.endpoint()).rejects.toThrow('account changed')
  id = null; await host.resume()
  expect(queues[1]!.dispose).toHaveBeenCalledOnce()
})
