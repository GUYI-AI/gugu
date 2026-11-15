// @vitest-environment node
// @@@durable-snapshot — a warm start adopts the stored list at the committed cursor and reads nothing; afterwards only
// what the journal names is read, and a stored conversation the journal touches is read whole before it is re-assembled.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatItem } from '@gugu/core/shared/types/chat'

type Response = { data: unknown; error: { message: string } | null }
const calls: Array<{ key: string; columns?: string; ids?: readonly string[] }> = []
const rowsByKey = new Map<string, unknown[]>()
function builder(key: string, args?: { p_chat_ids?: readonly string[] }): unknown {
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
          return Promise.resolve({ data: scoped, error: null }).then(onFulfilled, onRejected)
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
    return ids.map((id) => ({ id, display_name: `name-${id}`, type: 'human' }))
  },
}))
vi.mock('../../../../apps/desktop/src/lib/messageIngest', () => ({ ingestMessages: async () => undefined }))
const { createChatProjection } = await import('../../../../apps/desktop/src/lib/chatProjection')

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
  rowsByKey.clear()
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

  it('without a whole stored list it takes the keyset read', async () => {
    const projection = createChatProjection(VIEWER, { rows: () => [], identity: () => undefined, durable: () => null })
    expect(await projection.hydrate('9', signal())).toHaveLength(3)
    expect(keysetReads()).toBe(1)
  })
})
