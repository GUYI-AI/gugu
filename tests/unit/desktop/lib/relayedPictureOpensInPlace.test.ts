// @vitest-environment jsdom
// A message relayed into a private chat with an agent (its task page, both DM hosts) draws the original message's picture
// (originalMessagePresentation). Clicking it opens the picture over the conversation in the image viewer, as every
// message thumbnail does — it does not follow the file to the group that holds it. A file that is not a picture still
// opens where it lives (its chat's files), as before.
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ImageViewerRequest } from '@/lib/imageViewer'
import type { MessageItem } from '@gugu/core/shared/types/chat'
import { attachmentEnvelope } from '@gugu/core/shared/ui/attachmentModels'

const nav = vi.hoisted(() => ({ followLink: vi.fn(() => true), openLinkTarget: vi.fn(async () => undefined) }))
vi.mock('@/lib/guguLinks', async (original) => ({ ...(await original<object>()), followLink: nav.followLink, openLinkTarget: nav.openLinkTarget }))
const chat = vi.hoisted(() => ({ message: null as MessageItem | null }))
vi.mock('@/lib/chat', () => ({ chatService: { getMessageById: vi.fn(async () => chat.message) } }))
vi.mock('@/lib/supabase', async (original) => ({ ...(await original<object>()), getCurrentAuthUserId: vi.fn(async () => 'user-1') }))
const files = vi.hoisted(() => ({ fileMetadata: vi.fn() }))
vi.mock('@/lib/fileAccess', async (original) => ({ ...(await original<object>()), fileMetadata: files.fileMetadata }))

const { originalMessagePresentation } = await import('@/session/renderer/lib/chat/delivered-message-presentation')
const { followConversationLink } = await import('@/lib/followConversationLink')
const { registerImageViewerHost } = await import('@/lib/imageViewer')

const GROUP = 'c1111111-2222-4333-8444-555555555555'
function groupMessage(fileName: string, mime: string): MessageItem {
  return {
    id: 'a1111111-2222-4333-8444-555555555551', chat_id: GROUP, sender_id: 'user-1', content_type: 'attachment',
    content: attachmentEnvelope(fileName, 2048, mime), created_at: '2026-11-26T01:00:00Z',
    file_item_id: 'f1111111-2222-4333-8444-555555555552', file_version: 3,
  } as unknown as MessageItem
}

let opened: ImageViewerRequest[]
let unregister: () => void
beforeEach(() => {
  opened = []; nav.followLink.mockClear(); nav.openLinkTarget.mockClear()
  unregister = registerImageViewerHost(request => { opened.push(request) })
  files.fileMetadata.mockResolvedValue({ status: 'ready', revision: { width: 1200, height: 800 } })
})
afterEach(() => { unregister() })

it('a relayed picture opens in the image viewer where it is, not in the group that holds the file', async () => {
  chat.message = groupMessage('shot.png', 'image/png')
  const [picture] = originalMessagePresentation(chat.message)!.attachments!
  expect(picture).toMatchObject({ kind: 'image' })
  expect(followConversationLink(picture!.href!)).toBe(true)
  await vi.waitFor(() => expect(opened).toHaveLength(1))
  expect(opened[0]!.items[0]!.resource?.target).toMatchObject({ kind: 'file', itemId: 'f1111111-2222-4333-8444-555555555552', version: 3 })
  expect(nav.followLink, 'no navigation to the file').not.toHaveBeenCalled()
  expect(nav.openLinkTarget, 'no chat or file page opened').not.toHaveBeenCalled()
})

it('a relayed file that is not a picture still opens where it lives', async () => {
  chat.message = groupMessage('notes.pdf', 'application/pdf')
  const [file] = originalMessagePresentation(chat.message)!.attachments!
  expect(followConversationLink(file!.href!)).toBe(true)
  await vi.waitFor(() => expect(nav.followLink.mock.calls.length + nav.openLinkTarget.mock.calls.length).toBe(1))
  expect(opened).toHaveLength(0)
})
