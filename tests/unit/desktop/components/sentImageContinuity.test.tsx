// @vitest-environment jsdom
// 自己发的图:从「发送中」的本地预览到确认后的正式文件,是同一个 <img>,中间不出现空框;换成别的附件时不能留下上一张图。
import { act, createElement } from 'react'
import { notifyManager } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createReactHarness, renderWithAppProviders } from '../../../support/testHarness'
import { MediaAttachmentBubble } from '../../../../apps/desktop/src/components/chat/MediaAttachmentBubble'
import { attachmentQueryClient } from '../../../../apps/desktop/src/lib/attachmentQueryClient'
import type { ParsedAttachment } from '@gugu/core/shared/ui/attachmentModels'

const f = vi.hoisted(() => ({ resolve: vi.fn() }))
vi.mock('@/lib/fileAccess', () => ({ resolveFile: f.resolve, fileReader: () => ({ accountId: 'user-1', actorId: 'user-1' }), fileReadSignal: () => undefined, attachmentCache: vi.fn(), attachmentCacheOrigin: 'https://fixture.invalid' }))
vi.mock('@/lib/chat', () => ({ chatService: { getMessageById: vi.fn() } }))
vi.mock('@/components/chat/sendAttachmentBatch', () => ({ sendAttachmentBatch: vi.fn() }))
vi.mock('@/components/extensionBundle/ExtensionBundleCard', () => ({ ExtensionBundleCard: () => null }))
vi.mock('@/components/markdown/Markdown', () => ({ Markdown: () => null }))
vi.mock('react-i18next', async original => ({ ...await original<object>(), useTranslation: () => ({ t: (key: string) => key }) }))

const sending: ParsedAttachment = { kind: 'image', fileName: 'a.png', mimeType: 'image/png', sizeBytes: 123, source: { kind: 'url', url: 'blob:local-preview' }, imageDimensions: { width: 4, height: 3 } }
// The group folder may rename the committed file (a.png → a (2).png).
const committed: ParsedAttachment = { ...sending, fileName: 'a (2).png', source: { kind: 'item', itemId: 'item-1', version: 1 } }
const other: ParsedAttachment = { ...committed, fileName: 'b.png', sizeBytes: 456, source: { kind: 'item', itemId: 'item-2', version: 1 } }
const revision = { source: 'managed-object', item_id: 'item-1', version: 1, file_name: 'a.png', content_type: 'image/png', size_bytes: 123, sha256: 'a'.repeat(64), width: 4, height: 3 }

describe('a sent image from sending to committed', () => {
  let harness: ReturnType<typeof createReactHarness>
  let deliver!: () => void
  beforeEach(() => {
    harness = createReactHarness(); attachmentQueryClient.clear(); vi.clearAllMocks()
    notifyManager.setNotifyFunction(callback => { act(callback) })
    vi.stubGlobal('IntersectionObserver', class {
      constructor(private callback: (entries: { isIntersecting: boolean }[]) => void) {}
      observe() { this.callback([{ isIntersecting: true }]) }
      disconnect() {}
    })
    URL.createObjectURL = vi.fn(() => 'blob:committed-thumb')
    URL.revokeObjectURL = vi.fn()
    HTMLImageElement.prototype.decode = vi.fn(async () => undefined) // jsdom does not decode
    f.resolve.mockImplementation(() => new Promise(resolve => {
      deliver = () => resolve({ status: 'ready', purpose: 'preview', revision, dispose: async () => undefined, content: async () => new Blob(['png'], { type: 'image/png' }) })
    }))
  })
  afterEach(() => { harness.cleanup(); attachmentQueryClient.clear(); notifyManager.setNotifyFunction(callback => callback()); vi.unstubAllGlobals() })
  const render = (meta: ParsedAttachment, messageId = 'm-1') => renderWithAppProviders(harness, createElement(MediaAttachmentBubble, { meta, messageId, isMine: true }))
  const img = () => harness.container.querySelector<HTMLImageElement>('img.chat-inline-image')
  const pending = () => harness.container.querySelector('.chat-inline-image--pending')

  it('keeps the same <img> on the local preview until the committed bytes are ready, then swaps its src', async () => {
    await render(sending)
    const first = img()
    expect(first?.getAttribute('src')).toBe('blob:local-preview')
    await render(committed)
    await vi.waitFor(() => expect(f.resolve).toHaveBeenCalledTimes(1))
    expect(pending()).toBeNull()
    expect(img()).toBe(first)
    expect(img()?.getAttribute('src')).toBe('blob:local-preview')
    await act(async () => { deliver() })
    await vi.waitFor(() => expect(img()?.getAttribute('src')).toBe('blob:committed-thumb'))
    expect(img()).toBe(first)
    expect(HTMLImageElement.prototype.decode).toHaveBeenCalledTimes(1)
  })

  it('a different attachment does not keep the previous image', async () => {
    await render(sending)
    await render(other)
    expect(img()).toBeNull()
    expect(pending()).not.toBeNull()
  })

  it('a different message does not keep the previous image', async () => {
    await render(committed, 'm-1'); await act(async () => { deliver() })
    await vi.waitFor(() => expect(img()).not.toBeNull())
    await render({ ...committed, source: { kind: 'item', itemId: 'item-3', version: 1 } }, 'm-2')
    expect(img()).toBeNull()
    expect(pending()).not.toBeNull()
  })
})
