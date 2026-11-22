// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { queryClient as attachmentQueryClient } from '@/lib/replica'
import { openAttachmentImage, openAttachmentImages, workingCopyImageItem, registerAttachmentImage } from '@/lib/attachmentBytes'
import { galleryAround, registerImageViewerHost, type ImageViewerRequest } from '@/lib/imageViewer'
// The replica reads for the signed-in account, as the product publishes it.
;(await import('../../../../apps/desktop/src/lib/replica')).followRendererSession('SIGNED_IN', 'owner')

const io = vi.hoisted(() => ({ resolve: vi.fn(), original: vi.fn(), put: vi.fn(), url: vi.fn(), revoke: vi.fn() }))
vi.mock('@/lib/fileAccess', () => ({ fileMetadata: async () => ({ status: 'gone' }),
  resolveFile: io.resolve, fileReader: () => ({ accountId: 'account', actorId: 'account' }), fileReadSignal: () => undefined, nativeLocalBytes: async () => null,
  attachmentCache: async () => ({ match: async () => undefined, put: io.put }), putAttachment: io.put, attachmentCacheOrigin: 'https://attachments.test',
}))
vi.mock('@gugu/core/shared/fileResolver', async original => ({ ...await original<typeof import('@gugu/core/shared/fileResolver')>(), fileBlob: io.original }))

const source = { kind: 'item' as const, itemId: 'file', version: 2 }
const revision = { source: 'managed-object', item_id: 'file', version: 2, file_name: 'photo.png', content_type: 'image/png', size_bytes: 8, sha256: '0'.repeat(64) }
let request: ImageViewerRequest
let unregister: () => void
beforeEach(() => {
  attachmentQueryClient.clear()
  vi.clearAllMocks()
  io.url.mockImplementation((blob: Blob) => blob.size === 5 ? 'blob:thumb' : 'blob:full')
  vi.stubGlobal('URL', class extends URL { static createObjectURL = io.url; static revokeObjectURL = io.revoke })
  unregister = registerImageViewerHost(value => { request = value })
  io.resolve.mockImplementation(async (_ref, _reader, options) => options?.purpose === 'preview'
    ? { status: 'ready', revision, content: async () => new Blob(['thumb']), dispose: vi.fn() }
    : { status: 'ready', revision, reader: { accountId: 'account' } })
  io.original.mockResolvedValue(new Blob(['original']))
})
afterEach(() => { request?.items[0].release?.(); unregister(); attachmentQueryClient.clear(); vi.unstubAllGlobals() })

it('opens synchronously without a read, then shares thumbnail and verified lazy-original capabilities', async () => {
  openAttachmentImage(source, 'photo.png', { chatId: 'chat', messageId: 'message' })
  expect(io.resolve).not.toHaveBeenCalled()
  const item = request.items[0]
  expect(item).toMatchObject({ url: '', file: { name: 'photo.png' }, source: { chatId: 'chat', messageId: 'message' }, resource: { kind: 'file', target: { kind: 'file', itemId: 'file', version: 2 } } })
  await expect(item.preview?.()).resolves.toBe('blob:thumb')
  expect(io.original).not.toHaveBeenCalled()
  const first = item.full!()
  expect(item.full!()).toBe(first)
  await expect(first).resolves.toBe('blob:full')
  expect(io.original).toHaveBeenCalledTimes(1)
  item.release?.()
  expect(io.revoke.mock.calls).toEqual([['blob:thumb'], ['blob:full']])
})

it('releases a thumbnail that arrives after closing without fetching the original or opening again', async () => {
  let finish!: (value: Blob) => void
  const content = new Promise<Blob>(resolve => { finish = resolve })
  io.resolve.mockResolvedValue({ status: 'ready', revision, content: () => content, dispose: vi.fn() })
  openAttachmentImage(source, 'photo.png')
  const item = request.items[0], thumbnail = item.preview!()
  item.release?.()
  finish(new Blob(['thumb']))
  await expect(thumbnail).resolves.toBe('blob:thumb')
  expect(io.revoke).toHaveBeenCalledWith('blob:thumb')
  expect(io.original).not.toHaveBeenCalled()
})

it('opens an App page\'s images from the clicked one\'s picture, with its thumbnail and size, paging through the rest', async () => {
  io.resolve.mockImplementation(async (ref, _reader, options) => options?.purpose === 'preview'
    ? { status: 'ready', revision: { ...revision, item_id: ref.itemId, width: 1600, height: 900 }, content: async () => new Blob(['thumb']), dispose: vi.fn() }
    : { status: 'ready', revision, reader: { accountId: 'account' } })
  const images = [{ itemId: 'a', version: 1, name: 'a.png', contentType: 'image/png' }, { itemId: 'b', version: 4, name: 'b.png', contentType: 'image/png' }]
  const box = { x: 40, y: 60, width: 120, height: 120 }
  await openAttachmentImages(images, 1, { chatId: 'chat' }, box)
  expect(request.index).toBe(1)
  expect(request.items.map((item) => item.alt)).toEqual(['a.png', 'b.png'])
  expect(request.items[1]).toMatchObject({ url: 'blob:thumb', thumbRect: box, size: { width: 1600, height: 900 }, resource: { target: { itemId: 'b', version: 4 } } })
  // The others are read when paged to; only the clicked one opens from its picture.
  expect(request.items[0]).toMatchObject({ url: '' })
  expect(request.items[0].thumbRect).toBeUndefined()
  expect(io.resolve).toHaveBeenCalledTimes(1)
})

it('does not hold the viewer back for a thumbnail that is slow to come', async () => {
  io.resolve.mockReturnValue(new Promise(() => {}))
  await openAttachmentImages([{ itemId: 'a', version: 1, name: 'a.png', contentType: 'image/png' }], 0, undefined, { x: 0, y: 0, width: 10, height: 10 })
  expect(request.items[0]).toMatchObject({ url: '', thumbRect: { width: 10 } })
})

it('retries a failed original read and shares the successful retry', async () => {
  io.original.mockRejectedValueOnce(new Error('host disconnected'))
  openAttachmentImage(source, 'photo.png')
  const item = request.items[0]
  await expect(item.full!()).rejects.toThrow('host disconnected')
  const retry = item.full!()
  expect(item.full!()).toBe(retry)
  await expect(retry).resolves.toBe('blob:full')
  expect(io.original).toHaveBeenCalledTimes(2)
  item.release!()
  item.release!()
  expect(io.revoke).toHaveBeenCalledTimes(1)
  await expect(item.full!()).rejects.toThrow('released')
})

it('retries working-copy image reads instead of remembering a failed promise', async () => {
  const read = vi.fn().mockRejectedValueOnce(new Error('disconnected')).mockResolvedValue(new Blob(['original']))
  const item = workingCopyImageItem('plot.png', read)
  await expect(item.preview!()).rejects.toThrow('disconnected')
  const retry = item.preview!()
  expect(item.preview!()).toBe(retry)
  await expect(retry).resolves.toBe('blob:full')
  item.release!()
  expect(read).toHaveBeenCalledTimes(2)
  expect(io.revoke).toHaveBeenCalledOnce()
})

it('refuses a new image read after release while safely settling reads already in flight', async () => {
  const read = vi.fn(async () => new Blob(['original']))
  const item = workingCopyImageItem('plot.png', read)
  item.release!()
  await expect(item.preview!()).rejects.toThrow('released')
  expect(read).not.toHaveBeenCalled()
})

it('lets a mounted image bubble retry its original through the shared viewer registration', async () => {
  const thumb = document.createElement('img')
  thumb.setAttribute('data-image-viewer-src', 'blob:thumb')
  const unregisterImage = registerAttachmentImage(thumb, source, { name: 'photo.png' })
  const item = galleryAround(thumb).items[0]
  io.original.mockRejectedValueOnce(new Error('offline'))
  try {
    await expect(item.full!()).rejects.toThrow('offline')
    await expect(item.full!()).resolves.toBe('blob:full')
  } finally { unregisterImage() }
  expect(io.revoke).toHaveBeenCalledWith('blob:full')
  expect(galleryAround(thumb).items[0].full).toBeUndefined()
})
