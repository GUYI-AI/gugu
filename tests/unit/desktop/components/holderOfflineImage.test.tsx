// @vitest-environment jsdom
// A project image kept on a machine that is off: the bubble names that machine, and reads the image again by itself when
// the machine is back — one of the reader's own machines through its device list, a teammate's through the resolver.
import { act, createElement } from 'react'
import { notifyManager } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createReactHarness, device, renderWithAppProviders } from '../../../support/testHarness'
import { MediaAttachmentBubble } from '../../../../apps/desktop/src/components/chat/MediaAttachmentBubble'
import { attachmentQueryClient } from '../../../../apps/desktop/src/lib/attachmentQueryClient'
import { HOLDER_ASK_MS, holderOfflineText } from '../../../../apps/desktop/src/lib/fileHost'
import { DevicesContext } from '../../../../apps/desktop/src/store/devicesContext'
import type { ParsedAttachment } from '@gugu/core/shared/ui/attachmentModels'
import type { Device } from '@gugu/core/shared/types/chat'

const f = vi.hoisted(() => ({ resolve: vi.fn(), metadata: vi.fn() }))
vi.mock('@/lib/fileAccess', () => ({ fileMetadata: f.metadata, resolveFile: f.resolve, fileReader: () => ({ accountId: 'reader', actorId: 'reader' }), fileReadSignal: () => undefined, attachmentCache: async () => ({ match: async () => undefined, put: async () => undefined }), attachmentCacheOrigin: 'https://fixture.invalid' }))
vi.mock('@/lib/chat', () => ({ chatService: { getMessageById: vi.fn() } }))
vi.mock('@/components/chat/sendAttachmentBatch', () => ({ sendAttachmentBatch: vi.fn() }))
vi.mock('@/components/extensionBundle/ExtensionBundleCard', () => ({ ExtensionBundleCard: () => null }))
vi.mock('@/components/markdown/Markdown', () => ({ Markdown: () => null }))

const image: ParsedAttachment = { kind: 'image', fileName: 'shot.png', mimeType: 'image/png', sizeBytes: 3, source: { kind: 'item', itemId: 'item-1', version: 2 } }
const kept = (online: boolean, label: string | null = 'Studio') => ({ status: 'ready', revision: { source: 'local', item_id: 'item-1', version: 2, host_device_id: 'studio', host_account_id: 'sender', host_label: label, host_online: online } })
const revision = { source: 'local', item_id: 'item-1', version: 2, file_name: 'shot.png', content_type: 'image/png', size_bytes: 3, sha256: 'a'.repeat(64), width: 4, height: 3 }
const readable = () => ({ status: 'ready', purpose: 'preview', revision, dispose: async () => undefined, content: async () => new Blob(['png'], { type: 'image/png' }) })

describe('an inline image whose machine is off', () => {
  let harness: ReturnType<typeof createReactHarness>
  beforeEach(() => {
    harness = createReactHarness(); attachmentQueryClient.clear(); vi.clearAllMocks()
    notifyManager.setNotifyFunction(callback => { act(callback) })
    vi.stubGlobal('IntersectionObserver', class {
      constructor(private callback: (entries: { isIntersecting: boolean }[]) => void) {}
      observe() { this.callback([{ isIntersecting: true }]) }
      disconnect() {}
    })
    URL.createObjectURL = vi.fn(() => 'blob:thumb')
    URL.revokeObjectURL = vi.fn()
    HTMLImageElement.prototype.decode = vi.fn(async () => undefined)
    f.resolve.mockRejectedValue(new Error('Studio is offline'))
    f.metadata.mockResolvedValue(kept(false))
  })
  afterEach(() => { vi.useRealTimers(); harness.cleanup(); attachmentQueryClient.clear(); notifyManager.setNotifyFunction(callback => callback()); vi.unstubAllGlobals() })
  const render = (devices: Device[] = []) => renderWithAppProviders(harness,
    createElement(DevicesContext.Provider, { value: { devices, loading: false, error: null, refresh: async () => {}, rename: async () => {}, remove: async () => {}, listBoundAgents: async () => [] } },
      createElement(MediaAttachmentBubble, { meta: image, messageId: 'm-1', isMine: false })))
  const img = () => harness.container.querySelector<HTMLImageElement>('img.chat-inline-image')
  const offlineShown = (machine = 'Studio') => vi.waitFor(async () => { await act(async () => {}); expect(harness.container.textContent).toContain(holderOfflineText({ machine })) })

  it('names the machine that keeps it, read afresh for that version, instead of a bare failure', async () => {
    await render()
    await offlineShown()
    expect(f.metadata).toHaveBeenCalledWith('item-1', 2)
    expect(holderOfflineText({ machine: 'Studio' })).toContain('Studio')
  })

  it('says “the computer that keeps it” when that machine has no name', async () => {
    f.metadata.mockResolvedValue(kept(false, null))
    await render()
    await offlineShown('')
    expect(holderOfflineText({ machine: '' })).not.toBe(holderOfflineText({ machine: 'Studio' }))
  })

  it('keeps the plain failure when the read failed for another reason', async () => {
    f.metadata.mockResolvedValue(kept(true))
    await render()
    await vi.waitFor(async () => { await act(async () => {}); expect(harness.container.querySelector('.chat-inline-image--pending')).toBeNull() })
    expect(harness.container.textContent).not.toContain(holderOfflineText({ machine: 'Studio' }))
  })

  it('reads again by itself when the reader’s own machine comes back in the device list', async () => {
    await render([device('studio', [], { status: 'offline', is_online: false })])
    await offlineShown()
    expect(f.resolve).toHaveBeenCalledTimes(1)
    f.resolve.mockResolvedValue(readable())
    await render([device('studio', [])])
    await vi.waitFor(() => expect(img()?.getAttribute('src')).toBe('blob:thumb'))
    expect(f.resolve).toHaveBeenCalledTimes(2)
  })

  it('reads again by itself when a teammate’s machine, in no device list of the reader, is back', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    await render([device('reader-laptop', [])])
    await offlineShown()
    // Still off: asked again, nothing read.
    await act(async () => { await vi.advanceTimersByTimeAsync(HOLDER_ASK_MS) })
    expect(f.metadata).toHaveBeenCalledTimes(2)
    expect(f.resolve).toHaveBeenCalledTimes(1)
    f.metadata.mockResolvedValue(kept(true))
    f.resolve.mockResolvedValue(readable())
    await act(async () => { await vi.advanceTimersByTimeAsync(HOLDER_ASK_MS) })
    await vi.waitFor(() => expect(img()?.getAttribute('src')).toBe('blob:thumb'))
    expect(f.resolve).toHaveBeenCalledTimes(2)
    // Shown: nobody waits on that machine any more, so nothing is asked again.
    const asked = f.metadata.mock.calls.length
    await act(async () => { await vi.advanceTimersByTimeAsync(HOLDER_ASK_MS * 2) })
    expect(f.metadata).toHaveBeenCalledTimes(asked)
  })
})
