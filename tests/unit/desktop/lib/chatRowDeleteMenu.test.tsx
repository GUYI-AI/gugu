// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createReactHarness, chat, clickElement, displayIdentity } from '../../../support/testHarness'
import { ChatRowContextMenu } from '../../../../apps/desktop/src/components/chat/ChatRowContextMenu'
import { ConversationDeleteConfirmationHost } from '../../../../apps/desktop/src/components/chat/ConversationDeleteConfirmationHost'
const scope = vi.hoisted(() => ({ identitiesById: {} as Record<string, ReturnType<typeof displayIdentity>>, settings: vi.fn(), clear: vi.fn(async () => {}) }))
vi.mock('../../../../apps/desktop/src/store/chatContext', () => ({ useChatStore: () => ({ chats: [], identitiesById: scope.identitiesById, clearConversation: scope.clear }) }))
vi.mock('../../../../apps/desktop/src/store/auth', () => ({ useAuth: () => ({ user: { id: 'owner' } }) }))
vi.mock('../../../../apps/desktop/src/hooks/useMarkChatsRead', () => ({ useMarkChatsRead: () => vi.fn() }))
vi.mock('../../../../apps/desktop/src/components/toastContext', () => ({ useToast: () => ({ toast: vi.fn() }) }))
vi.mock('../../../../apps/desktop/src/components/chat/useGroupChatSettings', () => ({ useGroupChatSettings: scope.settings }))
let harness: ReturnType<typeof createReactHarness>
const onHide = vi.fn(async () => undefined)
const removal = () => document.querySelector<HTMLElement>('[data-testid="conversation-row-hide-chat"]')
const render = (kind: 'dm' | 'ai' | 'group' | 'topic' = 'dm') => harness.render(<><ChatRowContextMenu chat={chat({ id: 'chat', kind, name: '设计评审', alias: '设计评审', peer_alias: '设计评审', peer_user_id: 'agent' })} x={40} y={40} onClose={vi.fn()} onPin={vi.fn()} onSetNotificationLevel={vi.fn()} onHide={onHide} /><ConversationDeleteConfirmationHost /></>)
beforeEach(() => {
  harness = createReactHarness(); onHide.mockClear(); scope.clear.mockClear(); scope.settings.mockClear()
  scope.identitiesById = { agent: displayIdentity('agent', { type: 'agent', owner_user_id: 'owner', session_archived_at: null, removed_at: null }) }
})
afterEach(() => { harness.cleanup() })
it.each(['dm', 'ai', 'group', 'topic'] as const)('offers personal removal for %s without group-management dependencies', async (kind) => {
  await render(kind)
  expect(removal()?.textContent).toContain('不显示')
  await clickElement(removal()!)
  await vi.waitFor(() => expect(onHide).toHaveBeenCalledOnce())
  expect(scope.settings).not.toHaveBeenCalled()
  expect(document.querySelector('[data-testid=conversation-delete-confirm]')).toBeNull()
})
it.each([{ type: 'human' as const, owner_user_id: null }, { type: 'agent' as const, owner_user_id: 'another-owner' }])('also hides human and foreign-Agent conversations', async (identity) => {
  scope.identitiesById.agent = displayIdentity('agent', identity)
  await render(); await clickElement(removal()!)
  await vi.waitFor(() => expect(onHide).toHaveBeenCalledOnce())
})

it('offers a distinct confirmed history deletion while hiding remains immediate', async () => {
  await render()
  const deletion = document.querySelector<HTMLElement>('[data-testid="conversation-row-delete-chat"]')
  expect(deletion?.textContent).toBe('清空聊天记录')
  expect([...document.querySelectorAll('[data-testid^="conversation-row-"]')].map(row => row.textContent)).toEqual([
    '置顶', '标为已读', '关闭通知', '不显示', '清空聊天记录',
  ])
  expect(deletion?.previousElementSibling?.getAttribute('role')).toBe('separator')
  await clickElement(deletion!)
  expect(scope.clear).not.toHaveBeenCalled()
  const dialog = document.querySelector('[role=dialog]')!
  expect(dialog.textContent).toContain('清空「设计评审」的聊天记录？')
  expect(dialog.textContent).toContain('只清你这边，其他成员不受影响。')
  expect(dialog.textContent).toContain('同时删除 Agent')
  expect(document.querySelector('[role=dialog] [role=checkbox]')?.getAttribute('aria-checked')).toBe('false')
  await clickElement(document.querySelector<HTMLElement>('[data-testid=conversation-delete-submit]')!)
  await vi.waitFor(() => expect(scope.clear).toHaveBeenCalledWith('chat'))
  expect(onHide).not.toHaveBeenCalled()
})
