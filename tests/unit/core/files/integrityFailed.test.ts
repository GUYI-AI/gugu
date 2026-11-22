import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { forgedFileServer } from '../../../support/forgedFileHandle'
import { copyVerifiedFile } from '../../../../packages/core/src/shared/fileCipher'
import { FileIntegrityError, isFileIntegrityError, type FileHandle } from '../../../../packages/core/src/shared/fileResolver'
import { createNodeFileResolver, writeFileHandle } from '../../../../packages/core/src/local/files/fileSnapshots'

// Direct upload contract §2.5: a blob's sha256 is its uploader's claim. Every byte path checks the bytes against the pinned
// sha and fails `integrity_failed` with nothing delivered. Thumbnails and video stream links are exempt (provider-processed
// pixels and ranges, not the original bytes); the original read of the same file still fails here.
const claimed = new Uint8Array(700_001).fill(7), forged = new Uint8Array(700_001).fill(8)
const dirs: string[] = []
const scratch = async () => { const dir = await mkdtemp(join(tmpdir(), 'gugu-integrity-')); dirs.push(dir); return dir }
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))) })

describe('integrity_failed: every reader refuses bytes that are not the pinned sha', () => {
  it('the shared resolver over the cloud provider (renderer, phone, main): nothing read, its chunks dropped', async () => {
    const server = forgedFileServer(claimed, forged)
    const file = await server.handle()
    const failure = await file.read(0, 16).catch(error => error)
    expect(failure).toBeInstanceOf(FileIntegrityError)
    expect(failure.code).toBe('integrity_failed')
    expect(server.delivered).toEqual([])
    expect(server.chunks.size).toBe(0)
    await file.dispose()
  })

  it('the same path delivers honest bytes (control)', async () => {
    const server = forgedFileServer(claimed, claimed)
    const file = await server.handle()
    expect(Array.from(await file.read(0, 4))).toEqual([7, 7, 7, 7])
    await file.dispose()
  })

  it('desktop and headless saves (createNodeFileResolver saveTo): no file is left', async () => {
    const server = forgedFileServer(claimed, forged)
    const root = await scratch(), target = await scratch()
    const file = await createNodeFileResolver(root, async () => server.endpoint)({ item_id: 'item' }, { accountId: 'owner', actorId: 'reader' })
    if (file.status !== 'ready') throw Error('ready expected')
    await expect(file.saveTo!(target, 'file.bin')).rejects.toBeInstanceOf(FileIntegrityError)
    expect(await readdir(target, { recursive: true })).toEqual([])
  })

  it('an export of a handle (writeFileHandle) removes its partial file', async () => {
    const server = forgedFileServer(claimed, forged)
    const handle = { revision: server.revision, async *stream() { yield forged }, dispose: async () => {} } as unknown as FileHandle
    const target = await scratch()
    await expect(writeFileHandle(handle, join(target, 'out', 'file.bin'))).rejects.toBeInstanceOf(FileIntegrityError)
    expect(await readdir(target, { recursive: true })).toEqual([])
  })

  it('copyVerifiedFile aborts its sink before committing', async () => {
    const server = forgedFileServer(claimed, forged)
    let committed = false, aborted = false
    await expect(copyVerifiedFile(server.revision, { size: forged.length, read: async (o, l) => forged.subarray(o, o + l), dispose: async () => {} },
      { write: async () => {}, commit: async () => { committed = true; return null as never }, abort: async () => { aborted = true } })).rejects.toBeInstanceOf(FileIntegrityError)
    expect({ committed, aborted }).toEqual({ committed: false, aborted: true })
  })

  it('keeps its code across a process boundary, where only the message arrives', () => {
    expect(isFileIntegrityError(new Error(`Error invoking remote method 'files:stage': ${new FileIntegrityError().message}`))).toBe(true)
    // Android PrivateFileSink rejects with this message.
    expect(isFileIntegrityError(new Error('integrity_failed: File SHA-256 mismatch'))).toBe(true)
    expect(isFileIntegrityError(new Error('Truncated file stream'))).toBe(false)
  })
})
