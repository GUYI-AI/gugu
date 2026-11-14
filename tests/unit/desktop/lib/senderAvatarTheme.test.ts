// @vitest-environment jsdom
import { expect, it } from 'vitest'
import { subscribeSenderAvatars, senderAvatarUrl } from '../../../../apps/desktop/src/session/renderer/lib/chat/sender-avatar'
import { installIdentityDirectoryBridge, publishIdentityDirectory } from '../../../../apps/desktop/src/lib/identityDirectoryBridge'
import type { DisplayIdentity } from '../../../../apps/desktop/src/lib/displayIdentity'

it('refreshes existing session, scheduled-agent and project image subscribers on theme changes', async () => {
  const id = '11111111-1111-4111-8111-111111111111'
  document.documentElement.dataset.theme = 'light'
  installIdentityDirectoryBridge()
  publishIdentityDirectory({ [id]: { id, type: 'human', avatar: null } as DisplayIdentity }, () => {})
  const light = senderAvatarUrl(`user:${id}`), updates: (string | null)[] = []
  const off = subscribeSenderAvatars(() => updates.push(senderAvatarUrl(`user:${id}`)))
  try {
    document.documentElement.dataset.theme = 'dark'
    await new Promise<void>(resolve => queueMicrotask(resolve))
    expect(updates).toHaveLength(1)
    expect(updates[0]).not.toBe(light)
    expect(updates[0]).toBe(senderAvatarUrl(`user:${id}`))
    off()
    document.documentElement.dataset.theme = 'light'
    await new Promise<void>(resolve => queueMicrotask(resolve))
    expect(updates).toHaveLength(1)
  } finally {
    off()
    publishIdentityDirectory(null, null)
    delete document.documentElement.dataset.theme
  }
})
