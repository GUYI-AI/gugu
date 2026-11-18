// @vitest-environment jsdom
import { notifyManager } from '@tanstack/react-query'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GroupAgentItem, GroupChatSettings, GroupCollabSnapshot, GroupMemberItem, ListenMode } from '../../../packages/core/src/shared/types/chat'
import type { MemberProfileCardModel } from '../../../apps/desktop/src/components/MemberProfileCard'
import type { ActiveMemberProfile } from '../../../apps/desktop/src/components/memberProfileModels'
import { chat, clickElement, createNode, createReactHarness, renderWithAppProviders } from '../../support/testHarness'

vi.mock('../../../apps/desktop/src/lib/chat', () => ({
  chatService: { getGroupCollab: vi.fn(), getGroupChatSettings: vi.fn(), setAgentListenMode: vi.fn(async () => {}) },
}))

const shell = vi.hoisted(() => ({ mobile: false }))
vi.mock('../../../apps/desktop/src/hooks/useMobileShell', () => ({ useMobileShell: () => shell.mobile }))

const { MessageMemberProfileLayer } = await import('../../../apps/desktop/src/components/chat/MessageMemberProfileCard')
const { Popover } = await import('../../../apps/desktop/src/components/ui/Popover')
const { chatService } = await import('../../../apps/desktop/src/lib/chat')
const { useTopicScopedMemberProfile } = await import('../../../apps/desktop/src/hooks/useTopicScopedMemberProfile')
const { followRendererSession, queryClient } = await import('../../../apps/desktop/src/lib/replica')
const { openImRepository } = await import('../../../apps/desktop/src/lib/imRepository')
const { createMemoryLocalSyncDb } = await import('../../../apps/desktop/src/lib/localSyncDb')
const getGroupCollab = vi.mocked(chatService.getGroupCollab)
const getSettings = vi.mocked(chatService.getGroupChatSettings)
const setAgentListenMode = vi.mocked(chatService.setAgentListenMode)

function agentItem(id: string, listen_mode: GroupAgentItem['listen_mode']): GroupAgentItem {
  return {
    id, role: 'member', type: 'agent', account_status: 'active', client: null, model_source: null, tools: [],
    permission_scope: null, current_task_id: null, current_task_title: null, last_action: null, last_active_at: null,
    listen_mode,
  }
}
const humanItem = (id: string, role: GroupMemberItem['role']): GroupMemberItem => ({ id, role, type: 'human', account_status: null })
const collab = (agents: GroupAgentItem[], humans: GroupMemberItem[]): GroupCollabSnapshot => ({
  scheduler: { chat_id: 'topic-1', paused: false, queue_count: 0, blocked_count: 0, summary: null, updated_at: '2026-09-24T00:00:00.000Z' },
  humans, agents, tasks: [],
})

// 群名册里 a1 是「主动」—— 这正是名片过去在话题里显示的那个数。
const groupMember: MemberProfileCardModel = {
  id: 'a1', guguNumber: null, displayName: 'Claude 28', avatar: null, bio: null, email: null, type: 'agent',
  role: 'member', profileScope: 'group', listenMode: 'active', ownerUserId: 'owner-1',
}
const opened = (openedFrom: 'main' | 'aside'): ActiveMemberProfile => ({
  member: groupMember, preferredSide: 'right', openedFrom,
})
const groupEdit = { onChangeListenMode: vi.fn(async () => {}), busy: false }

let harness: ReturnType<typeof createReactHarness>
let result: ReturnType<typeof useTopicScopedMemberProfile>
function Probe({ mainTopicChatId = null, ...props }: { profile: ActiveMemberProfile | null; mainTopicChatId?: string | null; asideTopicChatId: string | null; authorityRevision?: number }) {
  result = useTopicScopedMemberProfile({ ...props, mainTopicChatId, currentUserId: 'owner-1', groupEditControlsFor: () => groupEdit })
  return null
}
// The roster is a replica: it reads for the signed-in account, through the account's open IM repository.
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
async function render(profile: ActiveMemberProfile | null, mainTopicChatId: string | null = null) {
  await harness.render(createNode(Probe, { profile, mainTopicChatId, asideTopicChatId: 'topic-1' }))
  await settle()
}

let repository: Awaited<ReturnType<typeof openImRepository>>
beforeEach(async () => {
  notifyManager.setScheduler((callback) => { callback() })
  followRendererSession('SIGNED_IN', 'owner-1')
  repository = await openImRepository('owner-1', { adapter: createMemoryLocalSyncDb() })
  harness = createReactHarness()
  setAgentListenMode.mockResolvedValue(undefined)
  getSettings.mockResolvedValue({ id: 'topic-1', my_role: 'member', can_manage: false } as GroupChatSettings)
})
afterEach(() => { harness.cleanup(); queryClient.clear(); repository.close(); vi.clearAllMocks() })

describe('useTopicScopedMemberProfile', () => {
  it('分栏点开:显示话题里的档位,改档写到话题 id', async () => {
    getGroupCollab.mockResolvedValue({ snapshot: collab([agentItem('a1', 'passive')], [humanItem('owner-1', 'owner')]), identities: [] })
    await render(opened('aside'))
    expect(getGroupCollab).toHaveBeenCalledWith('topic-1')
    expect(result?.profile.member.listenMode).toBe('passive')
    expect(result?.editControls).not.toBe(groupEdit)
    await act(async () => { await result?.editControls?.onChangeListenMode?.('active') })
    expect(setAgentListenMode).toHaveBeenCalledWith('topic-1', 'a1', 'active')
  })

  it('反例:主线点开的名片原样走群的档位和群的编辑控件', async () => {
    getGroupCollab.mockResolvedValue({ snapshot: collab([agentItem('a1', 'passive')], [humanItem('owner-1', 'owner')]), identities: [] })
    await render(opened('main'))
    expect(result?.profile.member.listenMode).toBe('active')
    expect(result?.editControls).toBe(groupEdit)
    expect(getGroupCollab).not.toHaveBeenCalled()
  })

  it.each(['main', 'aside'] as const)('hides listen mode for an agent outside the topic roster (%s)', async (opener) => {
    getGroupCollab.mockResolvedValue({ snapshot: collab([], [humanItem('owner-1', 'owner')]), identities: [] })
    await render(opened(opener), opener === 'main' ? 'topic-1' : null)
    expect(result?.profile.member.profileScope).toBe('direct')
    expect(result?.profile.member.listenMode).toBeUndefined()
    expect(result?.editControls).toBeUndefined()
  })

  it('lets a source-group manager edit a topic agent while keeping the topic write scope', async () => {
    getSettings.mockResolvedValue({ id: 'topic-1', my_role: 'admin', can_manage: true } as GroupChatSettings)
    getGroupCollab.mockResolvedValue({ snapshot: collab([agentItem('a1', 'passive')], [humanItem('owner-1', 'member')]), identities: [] })
    await render({ ...opened('aside'), member: { ...groupMember, ownerUserId: 'member-9' } })
    expect(getSettings).toHaveBeenCalledWith('topic-1')
    expect(result?.profile.member.listenMode).toBe('passive')
    await act(async () => { await result?.editControls?.onChangeListenMode?.('active') })
    expect(setAgentListenMode).toHaveBeenCalledWith('topic-1', 'a1', 'active')
  })

  it('does not infer source-group management from a topic-local owner seat', async () => {
    getGroupCollab.mockResolvedValue({ snapshot: collab([agentItem('a1', 'passive')], [humanItem('owner-1', 'owner')]), identities: [] })
    await render({ ...opened('aside'), member: { ...groupMember, ownerUserId: 'member-9' } })
    expect(result?.profile.member.listenMode).toBe('passive')
    expect(result?.editControls).toBeUndefined()
  })
})

it('re-reads topic authority on a source-group revision without changing its topic roster', async () => {
  getSettings.mockResolvedValue({ id: 'topic-1', my_role: 'admin', can_manage: true } as GroupChatSettings)
  getGroupCollab.mockResolvedValue({ snapshot: collab([agentItem('a1', 'passive')], [humanItem('owner-1', 'member')]), identities: [] })
  const profile = { ...opened('aside'), member: { ...groupMember, ownerUserId: 'member-9' } }
  await harness.render(createNode(Probe, { profile, asideTopicChatId: 'topic-1', authorityRevision: 0 }))
  await settle()
  expect(result?.editControls).toBeDefined()
  const before = getSettings.mock.calls.length
  getSettings.mockResolvedValue({ id: 'topic-1', my_role: 'member', can_manage: false } as GroupChatSettings)
  await harness.render(createNode(Probe, { profile, asideTopicChatId: 'topic-1', authorityRevision: 1 }))
  expect(getSettings).toHaveBeenCalledTimes(before + 1)
  expect(getSettings).toHaveBeenLastCalledWith('topic-1')
  expect(result?.editControls).toBeUndefined()
})

it('re-reads authority after a rejected mode write even without a revision event', async () => {
  getSettings.mockResolvedValue({ id: 'topic-1', my_role: 'admin', can_manage: true } as GroupChatSettings)
  getGroupCollab.mockResolvedValue({ snapshot: collab([agentItem('a1', 'passive')], [humanItem('owner-1', 'member')]), identities: [] })
  await render({ ...opened('aside'), member: { ...groupMember, ownerUserId: 'member-9' } })
  setAgentListenMode.mockRejectedValueOnce(Object.assign(new Error('permission denied'), { code: '42501' }))
  getSettings.mockResolvedValue({ id: 'topic-1', my_role: 'member', can_manage: false } as GroupChatSettings)
  await act(async () => { await result?.editControls?.onChangeListenMode?.('active') })
  expect(result?.editControls).toBeUndefined()
})

it.each([['desktop', false], ['phone', true]] as const)('changes only the topic membership from the %s main avatar card', async (_surface, mobile) => {
  shell.mobile = mobile
  const rows = new Map<string, ListenMode>([['group-1', 'passive'], ['topic-1', 'active']])
  getGroupCollab.mockImplementation(async (chatId) => {
    const mode = rows.get(chatId)
    if (!mode) throw new Error('Unexpected membership read for ' + chatId)
    return { snapshot: collab([agentItem('a1', mode)], [humanItem('owner-1', 'owner')]), identities: [] }
  })
  setAgentListenMode.mockImplementation(async (chatId, agentId, mode) => {
    expect(agentId).toBe('a1')
    rows.set(chatId, mode)
  })
  const card = Popover.createHandle<ActiveMemberProfile>()
  const sourceMember = { ...groupMember, listenMode: 'passive' as const }
  const trigger = createNode(Popover.Trigger, { handle: card, payload: { ...opened('main'), member: sourceMember } })
  await renderWithAppProviders(harness, createNode('div', {}, trigger, createNode(MessageMemberProfileLayer, {
    card,
    memberProfiles: { a1: sourceMember },
    authorityRevision: 0,
    asideTopic: null,
    chatId: 'topic-1',
    currentUserId: 'owner-1',
    isGroupChat: false,
    groupEditControlsFor: () => ({ busy: false, onChangeListenMode: (mode: ListenMode) => setAgentListenMode('group-1', 'a1', mode) }),
    onWhisper: vi.fn(),
  })), {
    auth: { id: 'owner-1' },
    chat: { activeChat: chat({ id: 'topic-1', kind: 'topic', name: 'Topic Test', source_chat_id: 'group-1' }), activeChatId: 'topic-1' },
    contacts: {},
  })
  await clickElement(harness.container.querySelector('button')!)
  await settle()
  const popup = document.body.querySelector('[data-testid="message-avatar-profile-menu"]')
  const segment = popup?.querySelectorAll<HTMLButtonElement>('.gg-pop-lm button')
  expect(segment).toHaveLength(2)
  const initiallyActive = segment?.[1]?.getAttribute('aria-pressed')

  await clickElement(segment![0]!)
  expect(setAgentListenMode.mock.calls).toEqual([['topic-1', 'a1', 'passive']])
  expect(rows.get('topic-1')).toBe('passive')
  expect(rows.get('group-1')).toBe('passive')
  expect(initiallyActive).toBe('true')
  expect(popup?.querySelector('.gg-pop-lml')?.textContent).toBe('Topic Test')
  expect(segment?.[0]?.getAttribute('aria-pressed')).toBe('true')
})
