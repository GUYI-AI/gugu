// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest'
import { FileReadRevokedError } from '@gugu/core/shared/fileResolver'
import { attachmentBytes } from '@/lib/attachmentBytes'

const io = vi.hoisted(() => ({ resolve: vi.fn(), shown: vi.fn(), put: vi.fn(), remove: vi.fn() }))
vi.mock('@/lib/fileAccess', () => ({ fileMetadata: async () => ({ status: 'gone' }),
  resolveFile: io.resolve, fileReader: () => ({ accountId: 'account', actorId: 'account' }), fileReadSignal: () => undefined,
  attachmentCache: async () => ({ put: io.put, delete: io.remove }), putAttachment: io.put, attachmentCacheOrigin: 'https://attachments.test',
}))
vi.mock('@gugu/core/shared/fileResolver', async original => ({ ...await original<typeof import('@gugu/core/shared/fileResolver')>(), shownFileBlob: io.shown }))

const source = { kind: 'item' as const, itemId: 'file', version: 2 }
const revision = { source: 'local', item_id: 'file', version: 2, file_name: 'page.html', content_type: 'text/html', size_bytes: 4, sha256: 'a'.repeat(64) }
const kept = `https://attachments.test/account/account/sha256/${'a'.repeat(64)}`
beforeEach(() => {
  vi.clearAllMocks()
  io.resolve.mockResolvedValue({ status: 'ready', revision, reader: { accountId: 'account' } })
})

it('shows the bytes before the acknowledgement and keeps the plaintext only once it is acknowledged', async () => {
  let acknowledge!: () => void
  io.shown.mockResolvedValue({ blob: new Blob(['page']), acknowledged: new Promise<void>(resolve => { acknowledge = resolve }) })
  const bytes = await attachmentBytes(source, 'shown')
  if (bytes.status !== 'ready' || !bytes.acknowledged) throw Error('shown bytes expected')
  expect(io.resolve.mock.calls[0]![2]).toMatchObject({ showFirst: true })
  expect(await bytes.blob.text()).toBe('page')
  expect(io.put).not.toHaveBeenCalled()
  acknowledge(); await bytes.acknowledged
  expect(io.put).toHaveBeenCalledWith(kept, expect.any(Blob)); expect(io.remove).not.toHaveBeenCalled()
})

it.each(['access', 'revision'] as const)('a revoked read (%s) keeps nothing and removes the plaintext an earlier open kept', async reason => {
  io.shown.mockResolvedValue({ blob: new Blob(['page']), acknowledged: Promise.reject(new FileReadRevokedError(reason)) })
  const bytes = await attachmentBytes(source, 'shown')
  if (bytes.status !== 'ready' || !bytes.acknowledged) throw Error('shown bytes expected')
  await expect(bytes.acknowledged).rejects.toMatchObject({ reason })
  expect(io.put).not.toHaveBeenCalled(); expect(io.remove).toHaveBeenCalledWith(kept)
})

it('a read that could not be acknowledged for another reason keeps nothing and leaves an earlier copy', async () => {
  io.shown.mockResolvedValue({ blob: new Blob(['page']), acknowledged: Promise.reject(new Error('network')) })
  const bytes = await attachmentBytes(source, 'shown')
  if (bytes.status !== 'ready' || !bytes.acknowledged) throw Error('shown bytes expected')
  await expect(bytes.acknowledged).rejects.toThrow('network')
  expect(io.put).not.toHaveBeenCalled(); expect(io.remove).not.toHaveBeenCalled()
})

it('a failure to keep the acknowledged copy leaves the read up', async () => {
  io.shown.mockResolvedValue({ blob: new Blob(['page']), acknowledged: Promise.resolve() })
  io.put.mockRejectedValueOnce(new DOMException('quota', 'QuotaExceededError'))
  const bytes = await attachmentBytes(source, 'shown')
  if (bytes.status !== 'ready' || !bytes.acknowledged) throw Error('shown bytes expected')
  await expect(bytes.acknowledged).resolves.toBeUndefined()
  expect(io.put).toHaveBeenCalledTimes(1); expect(io.remove).not.toHaveBeenCalled()
})
