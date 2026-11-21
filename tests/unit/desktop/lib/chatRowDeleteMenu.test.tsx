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
const archive = vi.hoisted(() => ({ confirm: vi.fn(async (_agentUserId: string, _name: string) => false), remove: vi.fn() }))
vi.mock('../../../../apps/desktop/src/lib/archiveOwnedAgent', () => ({ confirmOwnedAgentArchive: archive.confirm }))
vi.mock('../../../../apps/desktop/src/store/contactsContext', () => ({ useContactsStore: () => ({ removeOwnedAgent: archive.remove }) }))
const rows = () => [...document.querySelectorAll('[data-testid^="conversation-row-"]')].map(row => row.textContent)
let harness: ReturnType<typeof createReactHarness>
const onHide = vi.fn(async () => undefined)
const removal = () => document.querySelector<HTMLElement>('[data-testid="conversation-row-hide-chat"]')
const render = (kind: 'dm' | 'ai' | 'group' | 'topic' = 'dm') => harness.render(<><ChatRowContextMenu chat={chat({ id: 'chat', kind, name: '设计评审', alias: '设计评审', peer_alias: '设计评审', peer_user_id: 'agent' })} x={40} y={40} onClose={vi.fn()} onPin={vi.fn()} onSetNotificationLevel={vi.fn()} onHide={onHide} /><ConversationDeleteConfirmationHost /></>)
beforeEach(() => {
  harness = createReactHarness(); onHide.mockClear(); scope.clear.mockClear(); scope.settings.mockClear(); archive.confirm.mockClear()
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
  scope.identitiesById.agent = displayIdentity('agent', { type: 'human', owner_user_id: null })
  await render()
  const deletion = document.querySelector<HTMLElement>('[data-testid="conversation-row-delete-chat"]')
  expect(deletion?.textContent).toBe('清空聊天记录')
  expect(rows()).toEqual(['置顶', '标为已读', '关闭通知', '不显示', '清空聊天记录'])
  expect(deletion?.previousElementSibling?.getAttribute('role')).toBe('separator')
  await clickElement(deletion!)
  expect(scope.clear).not.toHaveBeenCalled()
  const dialog = document.querySelector('[role=dialog]')!
  expect(dialog.textContent).toContain('清空「设计评审」的聊天记录？')
  expect(dialog.textContent).toContain('仅清空你的聊天记录，其他成员不受影响。')
  expect(document.querySelector('[role=dialog] [role=checkbox]')).toBeNull()
  await clickElement(document.querySelector<HTMLElement>('[data-testid=conversation-delete-submit]')!)
  await vi.waitFor(() => expect(scope.clear).toHaveBeenCalledWith('chat'))
  expect(onHide).not.toHaveBeenCalled()
})

// owner 11-20: an Agent's DM has no clear history; my own active Agent's row archives it through the one agent archive.
it('my agent row archives through the agent archive confirmation and offers no clear history', async () => {
  await render()
  expect(rows()).toEqual(['置顶', '标为已读', '关闭通知', '不显示', '归档会话'])
  await clickElement(document.querySelector<HTMLElement>('[data-testid="conversation-row-archive"]')!)
  await vi.waitFor(() => expect(archive.confirm).toHaveBeenCalledOnce())
  expect(archive.confirm.mock.calls[0].slice(0, 2)).toEqual(['agent', '设计评审'])
  expect(scope.clear).not.toHaveBeenCalled()
})
it.each([
  ['someone else\'s agent', { type: 'agent' as const, owner_user_id: 'another-owner' }],
  ['my archived agent', { type: 'agent' as const, owner_user_id: 'owner', session_archived_at: '2026-11-20T00:00:00Z' }],
])('%s: no archive and no clear history', async (_name, identity) => {
  scope.identitiesById.agent = displayIdentity('agent', identity)
  await render()
  expect(rows()).toEqual(['置顶', '标为已读', '关闭通知', '不显示'])
})
