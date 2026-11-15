// @vitest-environment jsdom
// Owner 11-15: the message is there before its file's bytes. Someone else sees the attachment pending (the sender is still
// uploading) and its bytes fade in once the server says they are up (pushed, never polled); the sender draws its own copy
// meanwhile; nothing waits on the message.
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createReactHarness } from '../../../support/testHarness'
import type { AttachmentSource } from '@gugu/core/shared/ui/attachmentModels'
import type { FileMetadata } from '@gugu/core/shared/fileResolver'

const f = vi.hoisted(() => ({ resolve: vi.fn() }))
vi.mock('../../../../apps/desktop/src/lib/fileAccess', () => ({
  resolveFile: f.resolve,
  fileReader: () => ({ accountId: 'account-1', actorId: 'account-1' }),
  fileReadSignal: () => undefined,
  attachmentCache: async () => ({ match: async () => undefined, put: async () => undefined }),
  putAttachment: async () => undefined,
  attachmentCacheOrigin: 'https://attachments.gugu.invalid',
}))
vi.mock('../../../../apps/desktop/src/lib/attachmentUploads', () => ({ resumingCopy: () => null }))

import { useAttachmentObjectUrl } from '../../../../apps/desktop/src/lib/attachmentBytes'
import { forgetAttachmentChanges, noteAttachmentChanged } from '../../../../apps/desktop/src/lib/attachmentChanges'
import { forgetSentFiles, holdSentFile } from '../../../../apps/desktop/src/lib/sentFileCopies'
import { queryClient as attachmentQueryClient } from '../../../../apps/desktop/src/lib/readModel'
;(await import('../../../../apps/desktop/src/lib/readModel')).followRendererSession('SIGNED_IN', 'owner')

const revision = { sha256: 'a'.repeat(64), size_bytes: 3, content_type: 'image/png', source: 'managed-object', width: 4, height: 3 }
const ready = { status: 'ready', purpose: 'preview', revision, dispose: async () => undefined, content: async () => new Blob(['png'], { type: 'image/png' }) }
const pending: FileMetadata = { status: 'pending', sha256: null }
function Thumb({ source, metadata, messageId }: { source: AttachmentSource; metadata?: FileMetadata; messageId?: string }) {
  const view = useAttachmentObjectUrl(source, 'thumb', true, metadata, messageId ?? (source.kind === 'message' ? source.messageId : undefined))
  return createElement('span', { 'data-status': view.status, 'data-arrived': view.status === 'ready' && view.arrived ? 'yes' : 'no' })
}
const shown = (harness: ReturnType<typeof createReactHarness>) => harness.container.querySelector('span')

describe('an attachment whose sender is still uploading', () => {
  let harness: ReturnType<typeof createReactHarness>
  beforeEach(() => {
    attachmentQueryClient.clear(); forgetSentFiles(); forgetAttachmentChanges()
    f.resolve.mockReset()
    URL.createObjectURL = vi.fn(() => `blob:thumb-${Math.random()}`)
    URL.revokeObjectURL = vi.fn()
    HTMLImageElement.prototype.decode = vi.fn(async () => undefined)
    harness = createReactHarness()
  })
  afterEach(() => harness.cleanup())

  it('someone else sees it pending, asks nothing more until told, and its bytes arrive (to fade in) once they are up', async () => {
    f.resolve.mockResolvedValue(ready)
    await harness.render(createElement(Thumb, { source: { kind: 'message', messageId: 'theirs' }, metadata: pending }))
    expect(shown(harness)?.getAttribute('data-status')).toBe('pending')
    await new Promise(resolve => setTimeout(resolve, 1500))
    expect(f.resolve, 'no timer asks the server again').not.toHaveBeenCalled()
    await act(async () => { noteAttachmentChanged('theirs') })
    await vi.waitFor(() => expect(shown(harness)?.getAttribute('data-status')).toBe('ready'))
    expect(shown(harness)?.getAttribute('data-arrived')).toBe('yes')
    expect(f.resolve).toHaveBeenCalledOnce()
  })

  it('the sender draws its own copy at once, without asking the server, even when its row arrives before its send returns', async () => {
    holdSentFile('mine', new Blob(['png'], { type: 'image/png' }), 'blob:sending-preview')
    // The committed row reads the chat folder's file; nothing has mapped that address to the sent file yet.
    await harness.render(createElement(Thumb, { source: { kind: 'item', itemId: 'folder-file', version: 1 }, metadata: pending, messageId: 'mine' }))
    await vi.waitFor(() => expect(shown(harness)?.getAttribute('data-status')).toBe('ready'))
    expect(f.resolve).not.toHaveBeenCalled()
  })

  it('an upload that did not complete reads as unsent, and a pending answer is not remembered for the run', async () => {
    await harness.render(createElement(Thumb, { source: { kind: 'message', messageId: 'failed' }, metadata: { status: 'failed', sha256: null } }))
    expect(shown(harness)?.getAttribute('data-status')).toBe('unsent')
    f.resolve.mockResolvedValueOnce({ status: 'pending', sha256: null }).mockResolvedValue(ready)
    await harness.render(createElement(Thumb, { source: { kind: 'message', messageId: 'later' } }))
    await vi.waitFor(() => expect(shown(harness)?.getAttribute('data-status')).toBe('pending'))
    await harness.render(null)
    await harness.render(createElement(Thumb, { source: { kind: 'message', messageId: 'later' } }))
    await vi.waitFor(() => expect(shown(harness)?.getAttribute('data-status')).toBe('ready'))
    expect(f.resolve).toHaveBeenCalledTimes(2)
  })
})
