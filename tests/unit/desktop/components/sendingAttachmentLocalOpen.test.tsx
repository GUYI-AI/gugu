// @vitest-environment jsdom
import { act, createElement } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createReactHarness, renderWithAppProviders } from '../../../support/testHarness'
import { MediaAttachmentBubble } from '../../../../apps/desktop/src/components/chat/MediaAttachmentBubble'
import { forgetSentFiles, holdSentFile } from '../../../../apps/desktop/src/lib/sentFileCopies'
import type { ParsedAttachment } from '@gugu/core/shared/ui/attachmentModels'

vi.mock('@/lib/fileAccess', () => ({ fileMetadata: vi.fn(), resolveFile: vi.fn(), fileReader: () => ({ accountId: 'user-1', actorId: 'user-1' }), fileReadSignal: () => undefined, attachmentCache: vi.fn(), putAttachment: vi.fn(), attachmentCacheOrigin: 'https://fixture.invalid' }))
vi.mock('@/lib/chat', () => ({ chatService: { getMessageById: vi.fn() } }))
vi.mock('@/components/chat/sendAttachmentBatch', () => ({ sendAttachmentBatch: vi.fn() }))
vi.mock('@/components/extensionBundle/ExtensionBundleCard', () => ({ ExtensionBundleCard: () => null }))
vi.mock('@/components/markdown/Markdown', () => ({ Markdown: () => null }))
vi.mock('react-i18next', async original => {
  const zh = (await import('../../../../apps/desktop/src/i18n/locales/zh-CN/messaging')).default
  return { ...await original<object>(), useTranslation: () => ({ t: (key: string) => key.split('.').reduce<unknown>((value, part) => (value as Record<string, unknown>)?.[part], zh) ?? key }) }
})

const video: ParsedAttachment = { kind: 'file', fileName: 'clip.mov', mimeType: 'video/quicktime', sizeBytes: 5, source: { kind: 'url', url: 'blob:sending-clip' } }
let harness: ReturnType<typeof createReactHarness>
beforeEach(() => { harness = createReactHarness() })
afterEach(() => { harness.cleanup(); forgetSentFiles() })

it('a file still uploading opens from this device', async () => {
  holdSentFile('row-1', new File(['bytes'], 'clip.mov', { type: 'video/quicktime' }), 'blob:sending-clip')
  const onOpenFile = vi.fn()
  await renderWithAppProviders(harness, createElement(MediaAttachmentBubble, { meta: video, messageId: 'row-1', isMine: true, onOpenFile }))
  const card = harness.container.querySelector('button, [role="button"]') as HTMLElement
  await act(async () => { card.click() })
  expect(onOpenFile).toHaveBeenCalledExactlyOnceWith(video)
})

it('a sending preview from an earlier run has no bytes behind it and says so', async () => {
  const onOpenFile = vi.fn()
  await renderWithAppProviders(harness, createElement(MediaAttachmentBubble, { meta: { ...video, kind: 'image', mimeType: 'image/png', fileName: 'shot.png' }, messageId: 'row-2', isMine: true, onOpenFile }))
  expect(harness.container.querySelector('[data-attachment-unavailable]')).not.toBeNull()
  expect(harness.container.querySelector('img')).toBeNull()
})
