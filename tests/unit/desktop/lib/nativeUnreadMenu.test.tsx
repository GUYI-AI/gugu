// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createReactHarness, chat } from '../../../support/testHarness'
import { ChatRowContextMenu } from '../../../../apps/desktop/src/components/chat/ChatRowContextMenu'
import { publishDirectoryDevices, removeDeviceSessions, updateDeviceSessions } from '../../../../apps/desktop/src/session/shared/remote-sessions/session-directory'

const scope = vi.hoisted(() => ({ chats: [] as ReturnType<typeof chat>[], mark: vi.fn() }))
vi.mock('../../../../apps/desktop/src/store/chatContext', () => ({ useChatStore: () => ({ chats: scope.chats, identitiesById: {}, markUnread: vi.fn(async () => undefined), leaveGroup: vi.fn() }) }))
vi.mock('../../../../apps/desktop/src/store/auth', () => ({ useAuth: () => ({ user: { id: 'owner' } }) }))
vi.mock('../../../../apps/desktop/src/hooks/useMarkChatsRead', () => ({ useMarkChatsRead: () => scope.mark }))
vi.mock('../../../../apps/desktop/src/components/toastContext', () => ({ useToast: () => ({ toast: vi.fn() }) }))
vi.mock('../../../../apps/desktop/src/components/chat/useGroupChatSettings', () => ({ useGroupChatSettings: () => ({ settings: null, error: null }) }))

let harness: ReturnType<typeof createReactHarness>
beforeEach(() => {
  harness = createReactHarness()
  scope.mark.mockClear()
  scope.chats = [chat({ id: 'dm', kind: 'ai', peer_user_id: 'mine', unread_count: 0 })]
  publishDirectoryDevices([{ device_id: 'host', is_online: true } as never])
  updateDeviceSessions('host', { cached: false, sessions: [] })
})
afterEach(() => { harness.cleanup(); removeDeviceSessions('host'); publishDirectoryDevices([]) })
const action = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`)!
const render = () => harness.render(<ChatRowContextMenu chat={scope.chats[0]} x={40} y={40} onClose={vi.fn()} onPin={vi.fn()} onSetNotificationLevel={vi.fn()} onHide={vi.fn(async () => undefined)} />)

it('enables a personal read only for that row’s native replies', async () => {
  updateDeviceSessions('host', { sessions: [{ conversationId: 'other', agent: { userId: 'other' }, nativeUnreadKeys: ['reply'] } as never] })
  await render()
  // Nothing of this row unread: its mark read is disabled.
  expect(action('conversation-row-mark-read').hasAttribute('data-disabled')).toBe(true)
  await act(async () => updateDeviceSessions('host', { sessions: [{ conversationId: 'mine', agent: { userId: 'mine' }, nativeUnreadKeys: ['reply'] } as never] }))
  expect(action('conversation-row-mark-read').hasAttribute('data-disabled')).toBe(false)
  await act(async () => action('conversation-row-mark-read').click())
  expect(scope.mark).toHaveBeenCalledExactlyOnceWith('dm')
})
