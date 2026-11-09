// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { GroupCollabSnapshot } from '@gugu/core/shared/types/chat'
import type { ChatContextValue } from '../../../apps/desktop/src/store/chatContext'
import { openImRepository, readGroupRoster, replaceGroupRoster, type AccountImRepository } from '../../../apps/desktop/src/lib/imRepository'
import { createMemoryLocalSyncDb } from '../../../apps/desktop/src/lib/localSyncDb'
import { chat, createNode, createReactHarness, displayIdentity, renderWithAppProviders } from '../../support/testHarness'

// The roster goes through the real chatService.getGroupCollab; only the data client underneath is faked.
// list_member_ids answers what the server answers: the topic's current participants as seen by this reader.
const db = vi.hoisted(() => ({
  members: [] as string[],
  memberReads: [] as string[],
  pendingMembers: null as Promise<string[]> | null,
  manageable: false,
  infoReads: [] as string[],
}))
vi.mock('../../../apps/desktop/src/lib/supabase', () => {
  const query = (data: unknown) => {
    const builder: Record<string, unknown> = {}
    for (const method of ['select', 'eq', 'order', 'in', 'abortSignal']) builder[method] = () => builder
    builder.maybeSingle = () => Promise.resolve({ data: null, error: null })
    builder.then = (resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) => Promise.resolve({ data, error: null }).then(resolve, reject)
    return builder
  }
  const chatSchema = {
    from: () => query([]),
    rpc: async (name: string, args: { p_chat_id: string }) => {
      if (name === 'group_info_as') {
        db.infoReads.push(args.p_chat_id)
        return { data: { id: args.p_chat_id, name: 'Current topic', status: 'active', my_role: 'member', can_manage: db.manageable, can_dissolve: false, can_archive_topic: false }, error: null }
      }
      if (name !== 'list_member_ids') throw new Error(`unexpected rpc ${name}`)
      db.memberReads.push(args.p_chat_id)
      const ids = db.pendingMembers ? await db.pendingMembers : db.members
      return { data: ids.map((user_id) => ({ chat_id: args.p_chat_id, user_id, role: 'member', listen_mode: 'active' })), error: null }
    },
  }
  return {
    supabase: { auth: { getUser: vi.fn(), getSession: vi.fn(async () => ({ data: { session: null }, error: null })), onAuthStateChange: vi.fn() } },
    dataClient: { schema: () => chatSchema, channel: vi.fn(), removeChannel: vi.fn(), realtime: { setAuth: vi.fn() } },
    chatDb: chatSchema, identityDb: { from: () => query([]) },
    dbPayload: (value: unknown) => value, getCurrentAuthUserId: vi.fn(async () => 'viewer'), syncSchemaClientSession: vi.fn(async () => undefined),
  }
})
vi.mock('../../../apps/desktop/src/lib/identityReadAdapter', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../apps/desktop/src/lib/identityReadAdapter')>()),
  readDisplayIdentities: async (ids: readonly string[]) => ids.map((id) => displayIdentity(id, { display_name: id })),
}))
const shell = vi.hoisted(() => ({ mobile: false }))
vi.mock('../../../apps/desktop/src/hooks/useMobileShell', () => ({ useMobileShell: () => shell.mobile }))

const { chatService } = await import('../../../apps/desktop/src/lib/chat')
const { ChatSettingsPanel } = await import('../../../apps/desktop/src/components/chat/ChatSettingsPanel')
const { NATIVE_BACK_EVENT } = await import('../../../apps/desktop/src/components/ui/sheetStack')
vi.spyOn(chatService, 'listGroupJoinRequests').mockResolvedValue([])
const snapshot: GroupCollabSnapshot = {
  scheduler: { chat_id: 'topic-1', paused: false, queue_count: 0, blocked_count: 0, summary: null, updated_at: new Date(0).toISOString() },
  humans: [{ id: 'viewer', role: 'member', type: 'human', account_status: null }], agents: [], tasks: [],
}
let harness: ReturnType<typeof createReactHarness>
let repository: AccountImRepository
beforeEach(async () => {
  harness = createReactHarness()
  repository = await openImRepository('viewer', { adapter: createMemoryLocalSyncDb() })
  db.members = ['viewer', 'other']
  db.memberReads = []
  db.pendingMembers = null
  db.infoReads = []
})
afterEach(() => { harness.cleanup(); repository.close(); vi.useRealTimers() })

async function renderTopic(mobile: boolean, manageable: boolean, subscribeAccountRevision: ChatContextValue['subscribeAccountRevision'] = () => () => {}) {
  shell.mobile = mobile
  db.manageable = manageable
  const onClose = vi.fn()
  await renderWithAppProviders(harness, createNode(ChatSettingsPanel, {
    activeChat: chat({ id: 'source', kind: 'group', name: 'Source group' }),
    topic: { topicChatId: 'topic-1', name: 'Current topic' }, mobile,
    messages: [], onClose, onClearMessages: vi.fn(), onOpenSearch: vi.fn(),
    onSetNotificationLevel: vi.fn(), onTogglePinned: vi.fn(), memberProfiles: [], currentUserId: 'viewer',
    groupCollabSnapshot: snapshot, groupAgentStatuses: {}, onReloadGroupCollab: vi.fn(),
    onLeaveGroup: vi.fn(), onDissolveGroup: vi.fn(),
  }), {
    auth: { id: 'viewer' }, contacts: { contacts: [] },
    chat: { chats: [chat({ id: 'topic-1', kind: 'topic', name: 'Stale personal summary' })],
      identitiesById: { viewer: displayIdentity('viewer', { display_name: 'Viewer' }) },
      getImRepository: async () => repository, subscribeAccountRevision },
  })
  return onClose
}

it.each([[false, false], [false, true], [true, false], [true, true]])('topic info reuses the topic roster and server authority (mobile=%s, manageable=%s)', async (mobile, manageable) => {
  const close = await renderTopic(mobile, manageable)
  expect(db.memberReads).toContain('topic-1')
  expect(db.memberReads).not.toContain('source')
  expect(harness.container.querySelector('[data-member-row="other"]')).not.toBeNull()
  expect(db.infoReads).toContain('topic-1')
  expect(harness.container.querySelector('[data-testid="member-list-panel"]')?.getAttribute('data-chat-kind')).toBe('topic')
  expect(harness.container.querySelector('[data-testid="topic-name-edit"]')?.textContent).toContain('Current topic')
  expect(harness.container.querySelector('[data-testid="group-name-edit"]') !== null).toBe(manageable)
  expect(harness.container.querySelector('[data-testid="member-list-invite"]')).toBeNull()
  if (mobile) {
    await act(async () => { window.dispatchEvent(new Event(NATIVE_BACK_EVENT)) })
    expect(close).toHaveBeenCalledOnce()
  }
})

it('after the viewer leaves, a source member reads the remaining participants and loses their own row', async () => {
  let changed: Parameters<ChatContextValue['subscribeAccountRevision']>[1] | undefined
  await renderTopic(false, false, (event, listener) => {
    if (event === 'chat_members_changed') changed = listener
    return () => {}
  })
  expect(harness.container.querySelector('[data-member-row="viewer"]')).not.toBeNull()
  db.members = ['other']
  vi.useFakeTimers()
  await act(async () => {
    changed?.([{ revision: '2', event: 'chat_members_changed', payload: { chat_id: 'topic-1', user_id: 'viewer', kind: 'roster', tombstone: true } }])
    await vi.advanceTimersByTimeAsync(300)
  })
  expect(harness.container.querySelector('[data-member-row="viewer"]')).toBeNull()
  expect(harness.container.querySelector('[data-member-row="other"]')).not.toBeNull()
  expect(harness.container.querySelector('[data-member-list-error]')).toBeNull()
})

it('a reader with no visible participants gets the not-participant state, not the old rows', async () => {
  let changed: Parameters<ChatContextValue['subscribeAccountRevision']>[1] | undefined
  await renderTopic(false, false, (event, listener) => {
    if (event === 'chat_members_changed') changed = listener
    return () => {}
  })
  expect(harness.container.querySelector('[data-member-row="viewer"]')).not.toBeNull()
  db.members = []
  vi.useFakeTimers()
  await act(async () => {
    changed?.([{ revision: '2', event: 'chat_members_changed', payload: { chat_id: 'topic-1', user_id: 'viewer', kind: 'roster', tombstone: true } }])
    await vi.advanceTimersByTimeAsync(300)
  })
  expect(harness.container.querySelector('[data-member-list-error="not-participant"]')).not.toBeNull()
  expect(harness.container.querySelector('[data-member-row="viewer"]')).toBeNull()
  expect(harness.container.querySelector('[data-member-row="other"]')).toBeNull()
})

it('does not publish the local topic roster before current participation is confirmed', async () => {
  await replaceGroupRoster(repository, 'topic-1', snapshot, [displayIdentity('viewer', { display_name: 'Viewer' })])
  expect(readGroupRoster(repository, 'topic-1')?.humans).toHaveLength(1)
  let answer!: (ids: string[]) => void
  db.pendingMembers = new Promise((resolve) => { answer = resolve })
  await renderTopic(false, false)
  try {
    expect(harness.container.querySelector('[data-member-row="viewer"]')).toBeNull()
  } finally {
    await act(async () => { answer([]) })
  }
  expect(harness.container.querySelector('[data-member-list-error="not-participant"]')).not.toBeNull()
  expect(harness.container.querySelector('[data-member-row="viewer"]')).toBeNull()
})

it('refreshes topic authority on source-group revocation and ignores private read-position events', async () => {
  let changed: Parameters<ChatContextValue['subscribeAccountRevision']>[1] | undefined
  await renderTopic(false, true, (event, listener) => {
    if (event === 'chat_members_changed') changed = listener
    return () => {}
  })
  const before = db.memberReads.length
  vi.useFakeTimers()
  await act(async () => {
    changed?.([{ revision: '2', event: 'chat_members_changed', payload: { chat_id: 'topic-1', user_id: 'viewer', kind: 'own', tombstone: false } }])
    await vi.advanceTimersByTimeAsync(300)
  })
  expect(db.memberReads).toHaveLength(before)
  db.manageable = false
  db.infoReads = []
  await act(async () => {
    changed?.([{ revision: '3', event: 'chat_members_changed', payload: { chat_id: 'source', user_id: 'viewer', kind: 'roster', tombstone: false } }])
    await vi.advanceTimersByTimeAsync(300)
  })
  expect(db.infoReads).toContain('topic-1')
  expect(db.infoReads).not.toContain('source')
  expect(harness.container.querySelector('[data-testid="group-name-edit"]')).toBeNull()
})
