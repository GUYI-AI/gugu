// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createNode, createReactHarness } from '../../../../support/testHarness'
import { MessageQuotePreview } from '../../../../../apps/desktop/src/components/chat/ChatComposerContextBands'

const thumb = vi.hoisted(() => vi.fn())
vi.mock('@/lib/attachmentBytes', () => ({ useAttachmentObjectUrl: thumb }))

let harness: ReturnType<typeof createReactHarness>
beforeEach(() => {
  thumb.mockReset()
  thumb.mockReturnValue({ status: 'ready', objectUrl: 'blob:thumb', link: {}, retry: vi.fn() })
  harness = createReactHarness()
})
afterEach(() => harness.cleanup())

it('shows a quoted image as its thumbnail and file name', async () => {
  const source = { kind: 'item', itemId: 'item-1', version: 1 } as const
  await harness.render(createNode(MessageQuotePreview, { quote: { senderName: 'shuxue', content: 'shot.png',
    attachment: { kind: 'image', fileName: 'shot.png', mimeType: 'image/png', sizeBytes: 2048, source } } }))
  expect(thumb).toHaveBeenCalledWith(source, 'thumb', true, undefined)
  expect(harness.container.querySelector('[data-testid="quote-thumb"] img')?.getAttribute('src')).toBe('blob:thumb')
  expect(harness.container.textContent).toContain('shot.png')
  expect(harness.container.textContent).not.toContain('[Attachment]')
})

it('keeps a non-image attachment to its file name without a thumbnail', async () => {
  await harness.render(createNode(MessageQuotePreview, { quote: { senderName: 'shuxue', content: 'notes.pdf',
    attachment: { kind: 'file', fileName: 'notes.pdf', mimeType: 'application/pdf', sizeBytes: 10, source: { kind: 'gone' } } } }))
  expect(thumb).not.toHaveBeenCalled()
  expect(harness.container.querySelector('[data-testid="quote-thumb"]')).toBeNull()
  expect(harness.container.textContent).toContain('notes.pdf')
})
