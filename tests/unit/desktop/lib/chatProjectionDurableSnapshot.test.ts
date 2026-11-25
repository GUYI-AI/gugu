// @vitest-environment node
// @@@durable-snapshot — a warm start adopts the stored list at the committed cursor and reads nothing; afterwards only
// what the journal names is read, and a stored conversation the journal touches is read whole before it is re-assembled.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DisplayIdentity } from '../../../../apps/desktop/src/lib/displayIdentity'
import { displayIdentity } from '../../../support/testHarness'
import type { ChatItem } from '@gugu/core/shared/types/chat'

type Response = { data: unknown; error: { message: string } | null }
const calls: Array<{ key: string; columns?: string; ids?: readonly string[] }> = []
const rowsByKey = new Map<string, unknown[]>()
const errorsByKey = new Map<string, { message: string }>()
let delayedIdentities: Promise<DisplayIdentity[]> | null = null
function builder(key: string, args?: { p_chat_ids?: readonly string[] }): unknown {
  if (key === 'rpc:list_conversation_memberships') key = 'active_members'
  const call: { key: string; columns?: string; ids?: readonly string[] } = { key, ids: args?.p_chat_ids }
  const chain: unknown = new Proxy(function noop() {} as unknown as object, {
    get(_target, prop) {
      if (prop === 'select') return (columns: string) => { call.columns = columns; return chain }
      if (prop === 'in') return (_column: string, values: readonly string[]) => { call.ids = [...values]; return chain }
      if (prop === 'then') {
        return (onFulfilled: (value: Response) => unknown, onRejected?: (reason: unknown) => unknown) => {
          calls.push(call)
          const rows = (rowsByKey.get(key) ?? []) as Array<Record<string, unknown>>
          const scoped = call.ids && key === 'chats' ? rows.filter(row => call.ids!.includes(String(row.id)))
            : call.ids && key === 'active_members' ? rows.filter(row => call.ids!.includes(String(row.chat_id)))
              : rows
          return Promise.resolve({ data: scoped, error: errorsByKey.get(key) ?? null }).then(onFulfilled, onRejected)
        }
      }
      return () => chain
    },
    apply: () => chain,
  })
  return chain
}
vi.mock('../../../../apps/desktop/src/lib/supabase', () => ({
  chatDb: { from: (table: string) => builder(table), rpc: (fn: string, args: { p_chat_ids?: readonly string[] }) => builder(`rpc:${fn}`, args) },
  identityDb: { from: (table: string) => builder(table), rpc: (fn: string, args: { p_chat_ids?: readonly string[] }) => builder(`rpc:${fn}`, args) },
}))
vi.mock('../../../../apps/desktop/src/lib/identityReadAdapter', () => ({
  readDisplayIdentities: async (ids: readonly string[]) => {
    calls.push({ key: 'identity', ids })
    return delayedIdentities ?? ids.map((id) => displayIdentity(id, { display_name: `name-${id}`, type: 'human' }))
  },
}))
vi.mock('../../../../apps/desktop/src/lib/messageIngest', () => ({ ingestMessages: async () => undefined, initializeMessages: () => undefined, retireClosedMessageAccount: async () => undefined }))
const { createChatProjection, toProjectionOperations } = await import('../../../../apps/desktop/src/lib/chatProjection')

const VIEWER = 'u-viewer'
const PEER = 'u-peer'
const seat = (chat_id: string, user_id: string) => ({
  chat_id, user_id, last_read_seq: 0, is_marked_unread: false, version: 1, notification_level: 'all', is_pinned: false,
  updated_at: '2026-10-29T00:00:00Z', joined_at: '2026-10-29T00:00:00Z', inbox_published_at: '2026-10-29T00:00:00Z',
})
const chatRow = (id: string, kind: 'group' | 'dm', at: string) => ({
  id, public_id: null, kind, status: 'active', name: kind === 'group' ? id : null, avatar_url: null, created_at: '2026-10-29T00:00:00Z',
  last_message_at: at, last_message_preview: null, next_message_seq: 1, pinned_message_id: null,
})
beforeEach(() => {
  calls.length = 0
  delayedIdentities = null
  rowsByKey.clear()
  errorsByKey.clear()
  rowsByKey.set('active_members', [seat('g-1', VIEWER), seat('g-2', VIEWER), seat('d-1', VIEWER), seat('d-1', PEER)])
  rowsByKey.set('chats', [chatRow('g-1', 'group', '2026-11-01T00:00:00Z'), chatRow('g-2', 'group', '2026-11-02T00:00:00Z'), chatRow('d-1', 'dm', '2026-11-03T00:00:00Z')])
  rowsByKey.set('contact_overrides', [{ target_kind: 'user', target_id: PEER, alias: 'Pal' }])
})
const keysetReads = () => calls.filter(call => call.key === 'active_members' && call.columns === 'chat_id').length
const signal = () => new AbortController().signal

/** What the previous run left in the repository: its published rows and their people. */
async function storedList(): Promise<{ rows: ChatItem[]; identities: ReturnType<ReturnType<typeof createChatProjection>['identities']> }> {
  const previous = createChatProjection(VIEWER)
  const rows = await previous.hydrate('5', signal())
  calls.length = 0
  return { rows, identities: previous.identities() }
}

describe('warm start adopts the stored list', () => {
  it('reads nothing at start, nor on a refresh after the cursor moved', async () => {
    const stored = await storedList()
    const projection = createChatProjection(VIEWER, { rows: () => [], identity: () => undefined, durable: () => stored })
    expect((await projection.hydrate('9', signal())).map(row => row.id)).toEqual(['d-1', 'g-2', 'g-1'])
    expect(await projection.hydrate('40', signal())).toHaveLength(3)
    expect(calls).toEqual([])
  })

  it('publishes a committed hide from the stored row when a membership refresh would fail', async () => {
    const stored = await storedList()
    const projection = createChatProjection(VIEWER, { rows: () => stored.rows, identity: () => undefined, durable: () => stored })
    await projection.hydrate('9', signal())
    errorsByKey.set('active_members', { message: 'offline' })
    const hiddenAt = '2026-11-24T18:00:00Z'
    const receipt = { chat_id: 'g-1', hidden_at: hiddenAt, operation_id: 'hide', account_revision: '12' }
    const result = await projection.confirmPersonalHiding(receipt, signal())
    const before = stored.rows.find(row => row.id === 'g-1')
    expect(result.find(row => row.id === 'g-1')).toEqual({
      ...before, conversation_hidden_at: hiddenAt, conversation_visibility_revision: '12',
    })
    expect(projection.isConversationDeleted('g-1')).toBe(false)
    expect(calls).toEqual([])

    errorsByKey.clear()
    const operation = { event: 'chat_members_changed', chatId: 'g-1', entityId: VIEWER, own: true } as const
    const older = await projection.advance([{ ...operation, revision: '10' }], '10', signal())
    expect(older!.find(row => row.id === 'g-1')!.conversation_hidden_at).toBe(hiddenAt)
    await projection.advance([{ ...operation, revision: '13' }], '13', signal())
    const restored = await projection.confirmPersonalHiding(receipt, signal())
    expect(restored.find(row => row.id === 'g-1')).toMatchObject({
      conversation_hidden_at: null, conversation_visibility_revision: '13',
    })
  })

  it('a message reads only its conversation, whole, and keeps every other stored row as it was', async () => {
    const stored = await storedList()
    const projection = createChatProjection(VIEWER, { rows: () => stored.rows, identity: () => undefined, durable: () => stored })
    await projection.hydrate('9', signal())
    rowsByKey.set('chats', [chatRow('g-1', 'group', '2026-11-04T00:00:00Z')])
    const rows = await projection.advance([{ revision: '10', event: 'message_created', chatId: 'g-1', entityId: 'm-1' }], '10', signal())
    expect(rows!.map(row => row.id)).toEqual(['g-1', 'd-1', 'g-2'])
    expect(rows![1]).toBe(stored.rows[0])
    expect(rows![2]).toBe(stored.rows[1])
    expect(keysetReads()).toBe(0)
    expect(new Set(calls.flatMap(call => call.ids ?? []))).toEqual(new Set(['g-1']))
  })

  it('an alias change re-assembles the stored DM from its own cells instead of dropping it', async () => {
    const stored = await storedList()
    const projection = createChatProjection(VIEWER, { rows: () => stored.rows, identity: () => undefined, durable: () => stored })
    await projection.hydrate('9', signal())
    rowsByKey.set('contact_overrides', [{ target_kind: 'user', target_id: PEER, alias: 'Buddy' }])
    const rows = await projection.advance([{ revision: '10', event: 'friendship_changed', chatId: null, entityId: PEER }], '10', signal())
    expect(rows!.find(row => row.id === 'd-1')).toMatchObject({ peer_user_id: PEER, peer_alias: 'Buddy' })
    expect(rows).toHaveLength(3)
    expect(keysetReads()).toBe(0)
  })

  it('a stored conversation whose chat and seat an operation reads still gets its preview and unread read (no partial row)', async () => {
    rowsByKey.set('rpc:list_chat_previews', [{ chat_id: 'g-1', id: 'm-0', created_at: '2026-11-01T00:00:00Z', preview: 'stored line',
      seq: 1, content_type: 'text', sender_user_id: PEER, client_message_id: 'm-0' }])
    const stored = await storedList()
    const before = stored.rows.find(row => row.id === 'g-1')!
    expect(before.last_message_preview).toBeTruthy()
    const projection = createChatProjection(VIEWER, { rows: () => stored.rows, identity: () => undefined, durable: () => stored })
    await projection.hydrate('9', signal())
    const rows = await projection.advance([
      { revision: '10', event: 'chat_members_changed', chatId: 'g-1', entityId: null },
      { revision: '11', event: 'chat_members_changed', chatId: 'g-1', entityId: VIEWER, own: true },
    ], '11', signal())
    expect(rows!.find(row => row.id === 'g-1')!.last_message_preview).toEqual(before.last_message_preview)
    expect(calls.filter(call => call.key === 'rpc:list_chat_previews').flatMap(call => call.ids ?? [])).toContain('g-1')
    expect(keysetReads()).toBe(0)
  })

  it('a stored person is still read when an operation names them', async () => {
    const stored = await storedList()
    const projection = createChatProjection(VIEWER, { rows: () => stored.rows, identity: () => undefined, durable: () => stored })
    await projection.advance([{ revision: '7', event: 'agent_changed', chatId: null, entityId: PEER }], '9', signal())
    expect(calls.filter(call => call.key === 'identity').flatMap(call => call.ids ?? [])).toContain(PEER)
    expect(keysetReads()).toBe(0)
  })

  it.each(['personal-delete', 'membership-removed'] as const)('replays %s while the app was closed into authoritative removal facts', async (kind) => {
    const stored = await storedList()
    const projection = createChatProjection(VIEWER, { rows: () => stored.rows, identity: () => undefined, durable: () => stored })
    await projection.hydrate('9', signal())
    expect(projection.isConversationDeleted('g-1')).toBe(false)
    expect(projection.isMembershipRevoked('g-1')).toBe(false)
    const members = rowsByKey.get('active_members') as Array<Record<string, unknown>>
    rowsByKey.set('active_members', kind === 'membership-removed'
      ? members.filter(row => row.chat_id !== 'g-1' || row.user_id !== VIEWER)
      : members.map(row => row.chat_id === 'g-1' && row.user_id === VIEWER
        ? { ...row, conversation_deleted_at: '2026-11-19T00:00:00Z' } : row))
    const operations = toProjectionOperations([{ revision: '10', event: 'chat_members_changed',
      payload: { chat_id: 'g-1', entity_id: VIEWER, tombstone: kind === 'membership-removed',
        kind: kind === 'membership-removed' ? 'roster' : 'own' } }])
    const rows = await projection.advance(operations, '10', signal())
    expect(rows!.map(row => row.id)).not.toContain('g-1')
    expect(projection.isConversationDeleted('g-1')).toBe(kind === 'personal-delete')
    expect(projection.isMembershipRevoked('g-1')).toBe(kind === 'membership-removed')
    expect(keysetReads()).toBe(0)
  })

  it('does not invent a removal fact for a stale layout id absent from the stored snapshot', async () => {
    const complete = await storedList()
    const stored = { ...complete, rows: complete.rows.filter(row => row.id !== 'g-1') }
    const projection = createChatProjection(VIEWER, { rows: () => stored.rows, identity: () => undefined, durable: () => stored })
    await projection.hydrate('10', signal())
    expect(projection.isConversationDeleted('g-1')).toBe(false)
    expect(projection.isMembershipRevoked('g-1')).toBe(false)
    expect(calls).toEqual([])
  })

  it.each(['personal-delete', 'membership-removed', 'archived'] as const)('verifies a stale restored layout id after %s was already committed', async (kind) => {
    const complete = await storedList()
    const stored = { ...complete, rows: complete.rows.filter(row => row.id !== 'g-1') }
    const projection = createChatProjection(VIEWER, { rows: () => stored.rows, identity: () => undefined, durable: () => stored })
    await projection.hydrate('10', signal())
    const members = rowsByKey.get('active_members') as Array<Record<string, unknown>>
    rowsByKey.set('active_members', kind === 'membership-removed'
      ? members.filter(row => row.chat_id !== 'g-1' || row.user_id !== VIEWER)
      : members.map(row => row.chat_id === 'g-1' && row.user_id === VIEWER
        ? { ...row, conversation_deleted_at: kind === 'personal-delete' ? '2026-11-19T00:00:00Z' : null } : row))
    if (kind === 'archived') rowsByKey.set('chats', (rowsByKey.get('chats') as Array<Record<string, unknown>>).map(row => row.id === 'g-1' ? { ...row, status: 'archived' } : row))
    await projection.readRestoredLayoutMemberships(['g-1', 'g-1'], '10', signal())
    expect(projection.isConversationDeleted('g-1')).toBe(kind === 'personal-delete')
    expect(projection.isMembershipRevoked('g-1')).toBe(kind === 'membership-removed')
    expect(projection.isConversationArchived('g-1')).toBe(kind === 'archived')
    expect(calls).toEqual([{ key: 'active_members', ids: ['g-1'] }, expect.objectContaining({ key: 'chats', ids: ['g-1'] })])
    await projection.readRestoredLayoutMemberships(['g-1'], '10', signal())
    expect(calls).toHaveLength(2)
  })

  it('a failed restored-id read retains the unknown block and is not retried on publication or unrelated journal work', async () => {
    const stored = await storedList()
    const projection = createChatProjection(VIEWER, { rows: () => stored.rows, identity: () => undefined, durable: () => stored })
    await projection.hydrate('10', signal())
    errorsByKey.set('active_members', { message: 'offline' })
    await expect(projection.readRestoredLayoutMemberships(['g-1'], '10', signal())).rejects.toThrow('offline')
    expect(projection.isConversationDeleted('g-1')).toBe(false)
    expect(projection.isMembershipRevoked('g-1')).toBe(false)
    await projection.readRestoredLayoutMemberships(['g-1'], '10', signal())
    errorsByKey.clear()
    await projection.advance([{ revision: '11', event: 'message_created', chatId: 'g-2', entityId: 'm-1' }], '11', signal())
    expect(calls.filter(call => call.key === 'active_members' && call.ids?.includes('g-1'))).toHaveLength(1)
    expect(projection.current().map(row => row.id)).toContain('g-1')
  })

  it('without a whole stored list it takes the keyset read', async () => {
    const projection = createChatProjection(VIEWER, { rows: () => [], identity: () => undefined, durable: () => null })
    expect(await projection.hydrate('9', signal())).toHaveLength(3)
    expect(keysetReads()).toBe(1)
  })
})

// #1477: exercise the real durable projection, repository transaction and sidebar label,
// with a deferred initial identity GET rather than a timing-dependent sleep.
describe('identity publication ordering', () => {
  async function fixture() {
    const { createMemoryLocalSyncDb } = await import('../../../../apps/desktop/src/lib/localSyncDb')
    const { openImRepository, imSelectors, replaceChatRowsAndIdentities } = await import('../../../../apps/desktop/src/lib/imRepository')
    const { chatDisplayName } = await import('@gugu/core/shared/ui/chatModels')
    rowsByKey.set('contact_overrides', [])
    const stored = await storedList()
    stored.rows = stored.rows.map(row => row.id === 'd-1' ? { ...row, peer_alias: null } : row)
    stored.identities = stored.identities.map(identity => identity.id === PEER
      ? { ...identity, display_name: 'Codex 1', avatar: '/old.png' } : identity)
    const repository = await openImRepository(VIEWER, { adapter: createMemoryLocalSyncDb(), initialize: async () => {} })
    await replaceChatRowsAndIdentities(repository, stored.rows, stored.identities)
    const held = () => imSelectors.identitiesById(repository.snapshot())
    const projection = createChatProjection(VIEWER, {
      rows: () => imSelectors.chats(repository.snapshot()),
      identity: id => held()[id],
      durable: () => stored,
    })
    await projection.hydrate('9', signal())
    const latest = { ...held()[PEER]!, display_name: 'hello', avatar: '/new.png' }
    const publish = async (rows: ChatItem[], deferred = false) => replaceChatRowsAndIdentities(repository, rows, deferred ? projection.identities : projection.identities())
    const label = () => {
      const row = imSelectors.chats(repository.snapshot()).find(row => row.id === 'd-1')!
      return chatDisplayName(row, held()[PEER]?.display_name)
    }
    return { repository, projection, held, latest, publish, label }
  }
  function deferredIdentity() {
    let resolve!: (rows: DisplayIdentity[]) => void
    delayedIdentities = new Promise(done => { resolve = done })
    return resolve
  }

  it('keeps the new sidebar name and avatar when Pin publishes after a delayed initial GET', async () => {
    const f = await fixture()
    try {
      const resolve = deferredIdentity()
      const { readDisplayIdentities } = await import('../../../../apps/desktop/src/lib/identityReadAdapter')
      const initialGet = readDisplayIdentities([PEER]).then(rows => f.repository.putIdentities(rows))
      expect(f.label()).toBe('Codex 1')
      resolve([f.latest])
      await initialGet
      expect(f.label()).toBe('hello')
      calls.length = 0
      rowsByKey.set('active_members', [seat('d-1', PEER), { ...seat('d-1', VIEWER), is_pinned: true, version: 2 }])
      const rows = await f.projection.advance([{ revision: '10', event: 'chat_members_changed', chatId: 'd-1', entityId: VIEWER, own: true }], '10', signal())
      await f.publish(rows!)
      expect(f.label()).toBe('hello')
      expect(f.held()[PEER]!.avatar).toBe('/new.png')
      expect(f.repository.snapshot().chat.find(row => row.id === 'd-1')!.value.is_pinned).toBe(true)
      expect(calls.filter(call => call.key === 'identity')).toHaveLength(0)
    } finally { f.repository.close() }
  })

  it('does not let a delayed projection GET overwrite an identity changed while it was in flight', async () => {
    const f = await fixture()
    try {
      const old = f.held()[PEER]!
      const resolve = deferredIdentity()
      const reading = f.projection.advance([{ revision: '10', event: 'agent_changed', chatId: null, entityId: PEER }], '10', signal())
      await vi.waitFor(() => expect(calls.some(call => call.key === 'identity')).toBe(true))
      await f.repository.putIdentities([f.latest])
      resolve([old])
      await f.publish((await reading)!)
      expect(f.label()).toBe('hello')
      expect(f.held()[PEER]!.avatar).toBe('/new.png')
    } finally { f.repository.close() }
  })

  it('selects identities inside the queued repository write, after an earlier fresh publication', async () => {
    const f = await fixture()
    try {
      let release!: () => void
      const barrier = new Promise<void>(done => { release = done })
      const pending = f.repository.transaction(async () => { await barrier })
      const fresh = f.repository.putIdentities([f.latest])
      const publication = f.publish(f.projection.current(), true)
      release()
      await Promise.all([pending, fresh, publication])
      expect(f.label()).toBe('hello')
      expect(f.held()[PEER]!.avatar).toBe('/new.png')
    } finally { f.repository.close() }
  })

  it('still publishes a fresh identity read and retains the list identity closure', async () => {
    const f = await fixture()
    try {
      delayedIdentities = Promise.resolve([f.latest])
      const rows = await f.projection.advance([{ revision: '10', event: 'agent_changed', chatId: null, entityId: PEER }], '10', signal())
      await f.publish(rows!)
      expect(f.label()).toBe('hello')
      expect(f.held()[PEER]!.avatar).toBe('/new.png')
      expect(f.repository.snapshot().chat).toHaveLength(3)
    } finally { f.repository.close() }
  })
})

it('publishes a newly listed DM together with its previously unknown identity', async () => {
  const { createMemoryLocalSyncDb } = await import('../../../../apps/desktop/src/lib/localSyncDb')
  const { openImRepository, imSelectors, replaceChatRowsAndIdentities } = await import('../../../../apps/desktop/src/lib/imRepository')
  const stored = await storedList()
  const repository = await openImRepository(VIEWER, { adapter: createMemoryLocalSyncDb(), initialize: async () => {} })
  try {
    await replaceChatRowsAndIdentities(repository, stored.rows, stored.identities)
    const projection = createChatProjection(VIEWER, {
      rows: () => imSelectors.chats(repository.snapshot()),
      identity: id => imSelectors.identitiesById(repository.snapshot())[id],
      durable: () => stored,
    })
    await projection.hydrate('9', signal())
    rowsByKey.set('active_members', [...rowsByKey.get('active_members')!, seat('d-new', VIEWER), seat('d-new', 'new-peer')])
    rowsByKey.set('chats', [...rowsByKey.get('chats')!, chatRow('d-new', 'dm', '2026-11-25T00:00:00Z')])
    const rows = await projection.advance([{ revision: '10', event: 'chat_changed', chatId: 'd-new', entityId: null }], '10', signal())
    await replaceChatRowsAndIdentities(repository, rows!, projection.identities)
    expect(imSelectors.chats(repository.snapshot()).find(row => row.id === 'd-new')?.peer_user_id).toBe('new-peer')
    expect(imSelectors.identitiesById(repository.snapshot())['new-peer']?.display_name).toBe('name-new-peer')
  } finally { repository.close() }
})
