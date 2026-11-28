// @vitest-environment jsdom
// A picture a transcript row already drew opens out of that thumbnail, as a chat message's picture does: the same item
// (drawn pixels, the original after, the record's size, where it came from), opened now — not after reading the bytes
// again with nothing to open from.
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ImageViewerRequest } from '@/lib/imageViewer'

const files = vi.hoisted(() => ({ fileMetadata: vi.fn() }))
vi.mock('@/lib/fileAccess', async (original) => ({ ...(await original<object>()), fileMetadata: files.fileMetadata }))

const { openAttachmentImage } = await import('@/lib/attachmentBytes')
const { registerImageViewerHost } = await import('@/lib/imageViewer')

const PIXELS = 'data:image/gif;base64,R0lGODlhAQABAAAAACwAAAAAAQABAAA='
const MESSAGE = '11111111-2222-4333-8444-555555555555'

let opened: ImageViewerRequest[]
let unregister: () => void
beforeEach(() => {
  opened = []
  unregister = registerImageViewerHost(request => { opened.push(request) })
  files.fileMetadata.mockReset().mockResolvedValue({ status: 'ready', revision: { width: 3000, height: 1687 } })
})
afterEach(() => { unregister(); document.body.replaceChildren() })

function drawnThumbnail(): HTMLImageElement {
  const picture = document.body.appendChild(document.createElement('img'))
  picture.src = PIXELS
  Object.defineProperty(picture, 'complete', { value: true })
  Object.defineProperty(picture, 'naturalWidth', { value: 54 })
  return picture
}
const ITEM = 'a1111111-2222-4333-8444-555555555551'

it('opens a chat-folder picture out of the thumbnail the click was on, laid out at its record size', async () => {
  const picture = drawnThumbnail()
  openAttachmentImage({ kind: 'item', itemId: ITEM, version: 2 }, 'photo.jpg', { chatId: 'chat' }, { picture })
  await vi.waitFor(() => expect(opened).toHaveLength(1))
  const [item] = opened[0]!.items
  expect(item).toMatchObject({ url: PIXELS, thumb: picture, size: { width: 3000, height: 1687 }, source: { chatId: 'chat' },
    resource: { kind: 'file', target: { kind: 'file', itemId: ITEM, version: 2 } } })
  expect(item!.preview, 'the drawn pixels stand in for the thumbnail variant').toBeUndefined()
  expect(item!.full, 'the original still follows').toBeTypeOf('function')
})

it('opens a sent picture named by its message out of its thumbnail, without reading the message first', async () => {
  const picture = drawnThumbnail()
  openAttachmentImage({ kind: 'message', messageId: MESSAGE }, 'photo.jpg', undefined, { picture })
  await vi.waitFor(() => expect(opened).toHaveLength(1))
  expect(opened[0]!.items[0]).toMatchObject({ url: PIXELS, thumb: picture })
  expect(files.fileMetadata).not.toHaveBeenCalled()
})

it('opens at once with the thumbnail variant to read when nothing is drawn yet', () => {
  const broken = document.body.appendChild(document.createElement('img'))
  openAttachmentImage({ kind: 'message', messageId: MESSAGE }, 'photo.jpg', undefined, { picture: broken })
  expect(opened).toHaveLength(1)
  expect(opened[0]!.items[0]).toMatchObject({ url: '', preview: expect.any(Function), full: expect.any(Function) })
  expect(opened[0]!.items[0]!.thumb).toBeUndefined()
})

it('opens at once at the size its message knows, without asking the file record for it', async () => {
  const picture = drawnThumbnail()
  openAttachmentImage({ kind: 'item', itemId: ITEM, version: 2 }, 'photo.jpg', undefined, { picture, size: { width: 2400, height: 1600 } })
  await vi.waitFor(() => expect(opened).toHaveLength(1))
  expect(opened[0]!.items[0]).toMatchObject({ url: PIXELS, thumb: picture, size: { width: 2400, height: 1600 } })
  expect(files.fileMetadata, 'no wait on the network for a size the message already has').not.toHaveBeenCalled()
})
