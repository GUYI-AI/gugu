import { mkdtemp, chmod, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { attachmentSha256, pendingAttachmentUploads } from '@gugu/core/cloud/attachmentsApi'
import { localCopy, storeBytes, storedCopy } from '@gugu/core/local/files/fileSnapshots'
import { fileSha256 } from '@gugu/core/shared/fileCipher'
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
  const progress = vi.fn(), result = vi.fn(), host = createAttachmentUploadHost({ account: async () => ({ id: 'owner', home, endpoint: async () => ({ supabaseUrl: 'https://db.test', anonKey: 'a', token: 't', fetch: fetcher }) }), progress, result, warn: error => { throw error } })
  const { declared, uploaded } = await host.declare({ file: { name: 'file.txt', path: '', data: await bytes.arrayBuffer(), size: bytes.size, contentType: 'text/plain' }, chatId: 'chat', as: 'owner', messageId: 'm' })
  await uploaded
  expect(declared).toEqual({ staging_key: 'pending', sha256, size_bytes: bytes.size })
  expect(queues[0]!.begin).toHaveBeenCalledOnce()
  expect(await (queues[0]!.begin.mock.calls[0]![1] as Blob).text()).toBe('original')
  expect(await (await hosts[0]!.copyOf(sha256))?.text()).toBe('original')
  expect(await hosts[0]!.copyOf('f'.repeat(64))).toBeNull()
  hosts[0]!.progress('m', { sha256, loaded: 2, total: 8, attempt: 1 })
  expect(progress).toHaveBeenLastCalledWith({ messageId: 'm', sha256, loaded: 2, total: 8, attempt: 1 })
  hosts[0]!.progress('m')
  expect(result).toHaveBeenCalledExactlyOnceWith({ messageId: 'm', attempt: 1, elapsedMs: expect.any(Number), outcome: 'success' })
  await host.resume(); await host.retry('m'); await host.drop('m')
  expect(queues[0]!.resume).toHaveBeenCalledOnce(); expect(queues[0]!.retry).toHaveBeenCalledWith('m'); expect(queues[0]!.drop).toHaveBeenCalledWith('m')
  host.dispose(); expect(queues[0]!.dispose).toHaveBeenCalledOnce()
})
// One digest per send of a file on disk: the host hashes it to record where it is, and the declaration reuses that sha.
it('hashes a declared file on disk exactly once', async () => {
  const home = await mkdtemp(join(tmpdir(), 'declared-upload-host-')); roots.push(home)
  const path = join(home, 'once.bin'); await writeFile(path, 'hash me once')
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ staging_key: 'pending', url: 'https://store.test', fields: {}, max_bytes: 100 }), { status: 200 }))
  const host = createAttachmentUploadHost({ account: async () => ({ id: 'owner', home, endpoint: async () => ({ supabaseUrl: 'https://db.test', anonKey: 'a', token: 't', fetch: fetcher }) }), progress: vi.fn(), warn: error => { throw error } })
  const digests = vi.spyOn(fileSha256, 'create')
  try {
    const { declared } = await host.declare({ file: { name: 'once.bin', path, size: 12, contentType: 'application/octet-stream' }, chatId: 'chat', as: 'owner', messageId: 'm' })
    expect(digests).toHaveBeenCalledOnce()
    expect(declared.sha256).toBe(createHash('sha256').update('hash me once').digest('hex'))
    const [, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.parse(String(init.body))).toMatchObject({ sha256: declared.sha256 })
  } finally { digests.mockRestore() }
})
// A file on this disk is uploaded from where it is: nothing is copied, and an original changed before its upload finished
// is no copy at all — the upload owing it fails with that reason, a reader just does not find it here.
it('declares a file on disk by reference, and an original changed afterwards fails the upload owing it', async () => {
  const home = await mkdtemp(join(tmpdir(), 'declared-upload-host-')); roots.push(home)
  const path = join(home, 'picked.bin'); await writeFile(path, 'original on disk')
  const sha256 = createHash('sha256').update('original on disk').digest('hex')
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ staging_key: 'pending', url: 'https://store.test', fields: {}, max_bytes: 100 }), { status: 200 }))
  const host = createAttachmentUploadHost({ account: async () => ({ id: 'owner', home, endpoint: async () => ({ supabaseUrl: 'https://db.test', anonKey: 'a', token: 't', fetch: fetcher }) }), progress: vi.fn(), warn: error => { throw error } })
  const { declared } = await host.declare({ file: { name: 'picked.bin', path, size: 16, contentType: 'application/octet-stream' }, chatId: 'chat', as: 'owner', messageId: 'm' })
  expect(declared.sha256).toBe(sha256)
  expect(await readdir(home)).not.toContain('file-store')
  expect(await (queues[0]!.begin.mock.calls[0]![1] as Blob).text()).toBe('original on disk')
  expect(await (await hosts[0]!.copyOf(sha256))?.text()).toBe('original on disk')
  await writeFile(path, 'edited after send')
  await expect(hosts[0]!.copyOf(sha256)).rejects.toMatchObject({ code: 'original_changed' })
  expect(await localCopy(home, sha256)).toBeNull()
  await rm(path)
  await expect(hosts[0]!.copyOf(sha256)).rejects.toMatchObject({ code: 'original_changed' })
  host.dispose()
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
it('each service request reads fresh matching credentials, and a switched account cannot use the old endpoint', async () => {
  let id = 'one', token = 'before-refresh'
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ uploads: [] })))
  const host = createAttachmentUploadHost({ account: async () => ({ id, home: '/unused', endpoint: async () => ({
    supabaseUrl: 'https://db.test', anonKey: 'a', token, fetch: fetcher,
  }) }), progress: vi.fn(), warn: vi.fn() })
  await host.resume()
  const endpoint = await hosts[0]!.endpoint()
  token = 'after-refresh'
  await pendingAttachmentUploads(endpoint)
  expect(fetcher).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer after-refresh' }) }))
  id = 'two'
  await expect(pendingAttachmentUploads(endpoint)).rejects.toThrow('account changed')
  expect(fetcher).toHaveBeenCalledOnce()
  host.dispose()
})
