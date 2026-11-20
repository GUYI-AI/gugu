// @vitest-environment jsdom
// A delivered image drawn by every task page, DM host and remount of the same agent conversation reads through the
// chat's one thumbnail reading: the same source is resolved and signed once, concurrently or later.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const f = vi.hoisted(() => ({ resolve: vi.fn() }))
vi.mock('../../../../apps/desktop/src/lib/fileAccess', () => ({
  resolveFile: f.resolve,
  fileReader: () => ({ accountId: 'account-1', actorId: 'account-1' }),
  fileReadSignal: () => undefined,
  attachmentCache: async () => ({ match: async () => undefined, put: async () => undefined }),
  putAttachment: async () => undefined,
  attachmentCacheOrigin: 'https://attachments.gugu.invalid',
}))

import { resolveDeliveredAttachment } from '../../../../apps/desktop/src/session/renderer/lib/chat/delivered-message-presentation'
import { queryClient } from '../../../../apps/desktop/src/lib/replica'
;(await import('../../../../apps/desktop/src/lib/replica')).followRendererSession('SIGNED_IN', 'owner')

const revision = { sha256: 'a'.repeat(64), size_bytes: 3, content_type: 'image/png', source: 'managed-object' }
const id = 'gugu-message-file://11111111-2222-4333-8444-555555555555'

describe('delivered attachment pictures', () => {
  beforeEach(() => {
    queryClient.clear()
    f.resolve.mockReset().mockImplementation(async () => ({
      status: 'ready', purpose: 'preview', revision, dispose: async () => undefined, content: async () => new Blob(['png'], { type: 'image/png' }),
    }))
  })

  it('reads one delivered image once for every surface that draws it', async () => {
    const shown = await Promise.all([resolveDeliveredAttachment(id), resolveDeliveredAttachment(id), resolveDeliveredAttachment(id)])
    expect(shown.every(url => url?.startsWith('data:image/png'))).toBe(true)
    expect(await resolveDeliveredAttachment(id)).toBe(shown[0])
    expect(f.resolve).toHaveBeenCalledOnce()
    expect(f.resolve.mock.calls[0]![0]).toEqual({ message_id: '11111111-2222-4333-8444-555555555555' })
    expect(f.resolve.mock.calls[0]![2]).toMatchObject({ purpose: 'preview' })
  })
})
