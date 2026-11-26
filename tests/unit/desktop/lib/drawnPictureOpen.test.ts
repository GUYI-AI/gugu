// @vitest-environment jsdom
// A task message's picture follows its file's link when clicked. The thumbnail it already drew goes with that link, so
// the file opens out of it as a chat message's picture does: the same item (drawn pixels, the thumbnail, the original
// after, the record's size, where it came from) — not one that reads the bytes again with nothing to open from.
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ImageViewerRequest } from '@/lib/imageViewer'

const files = vi.hoisted(() => ({ fileMetadata: vi.fn() }))
vi.mock('@/lib/fileAccess', async (original) => ({ ...(await original<object>()), fileMetadata: files.fileMetadata }))

const { openAttachmentImages, openAttachmentImage } = await import('@/lib/attachmentBytes')
const { registerImageViewerHost, drawnPictureIsOf } = await import('@/lib/imageViewer')
const { noteDrawnPictureLink } = await import('@/lib/followConversationLink')

const PIXELS = 'data:image/gif;base64,R0lGODlhAQABAAAAACwAAAAAAQABAAA='
const MESSAGE = '11111111-2222-4333-8444-555555555555'

let opened: ImageViewerRequest[]
let unregister: () => void
beforeEach(() => {
  opened = []
  unregister = registerImageViewerHost(request => { opened.push(request) })
  files.fileMetadata.mockResolvedValue({ status: 'ready', revision: { width: 3000, height: 1687 } })
})
afterEach(() => { unregister(); document.body.replaceChildren() })

function drawnThumbnail(): HTMLImageElement {
  const picture = document.body.appendChild(document.createElement('img'))
  picture.src = PIXELS
  Object.defineProperty(picture, 'complete', { value: true })
  Object.defineProperty(picture, 'naturalWidth', { value: 54 })
  return picture
}
const image = { itemId: 'a1111111-2222-4333-8444-555555555551', version: 2, name: 'photo.jpg', contentType: 'image/jpeg' }

it('opens a linked chat-folder picture out of the thumbnail its click drew', async () => {
  const picture = drawnThumbnail()
  noteDrawnPictureLink('gugu-file://a1111111-2222-4333-8444-555555555551?v=2', picture)
  await openAttachmentImages([image], 0, { chatId: 'chat' })
  const [item] = opened[0]!.items
  expect(item).toMatchObject({ url: PIXELS, thumb: picture, size: { width: 3000, height: 1687 }, source: { chatId: 'chat' },
    resource: { kind: 'file', target: { kind: 'file', itemId: 'a1111111-2222-4333-8444-555555555551', version: 2 } } })
  expect(item!.preview, 'the drawn pixels stand in for the thumbnail variant').toBeUndefined()
  expect(item!.full, 'the original still follows').toBeTypeOf('function')
})

it('opens a sent picture, named by its message, out of its thumbnail once the message names the file', async () => {
  const picture = drawnThumbnail()
  noteDrawnPictureLink(`gugu-message-file://${MESSAGE}`, picture)
  drawnPictureIsOf(MESSAGE, 'a1111111-2222-4333-8444-555555555551', 2)
  openAttachmentImage({ kind: 'item', itemId: 'a1111111-2222-4333-8444-555555555551', version: 2 }, 'photo.jpg')
  await vi.waitFor(() => expect(opened).toHaveLength(1))
  expect(opened[0]!.items[0]).toMatchObject({ url: PIXELS, thumb: picture, size: { width: 3000, height: 1687 } })
})

it('keeps the link path as it was for another file, and lets a noted picture serve one opening only', async () => {
  noteDrawnPictureLink('gugu-file://b1111111-2222-4333-8444-555555555552?v=1', drawnThumbnail())
  await openAttachmentImages([image], 0)
  expect(opened[0]!.items[0]).toMatchObject({ url: expect.any(String), preview: expect.any(Function) })
  expect(opened[0]!.items[0]!.thumb).toBeUndefined()

  const picture = drawnThumbnail()
  noteDrawnPictureLink('gugu-file://a1111111-2222-4333-8444-555555555551?v=2', picture)
  await openAttachmentImages([image], 0)
  await openAttachmentImages([image], 0)
  expect(opened[1]!.items[0]!.thumb).toBe(picture)
  expect(opened[2]!.items[0]!.thumb, 'taken by the opening it was noted for').toBeUndefined()
})
