// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { openLocalSyncDb } from '../../../../apps/desktop/src/lib/localSyncDb'

const person = { id: 'human-1', type: 'human', display_name: 'Ada', avatar: null, gugu_number: null, bio: null, owner_user_id: null,
  agent_public: null, desired_status: null, device_id: null, category: null, is_official: null, local_path: null, created_at: null, updated_at: null }

describe('a stored row this build rejects drops alone', () => {
  beforeEach(() => { vi.stubGlobal('IDBKeyRange', IDBKeyRange); vi.spyOn(console, 'error').mockImplementation(() => {}) })
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

  it('drops a message window that no longer covers its messages, keeps the rest, and forgets the revision cursor', async () => {
    const adapter = await openLocalSyncDb(new IDBFactory())
    await adapter.commit([
      { type: 'put', store: 'identity', value: { accountId: 'a', id: 'human-1', value: person } },
      { type: 'put', store: 'view', value: { accountId: 'a', key: 'message-window:chat-1', value: { oldestSeq: 1, maxSeq: 3, hasMoreOlder: false } } },
      { type: 'put', store: 'view', value: { accountId: 'a', key: 'list-scroll', value: { top: 0 } } },
      { type: 'put', store: 'sync_state', value: { accountId: 'a', key: 'account-revision-cursor', value: { revision: '9' } } },
      { type: 'put', store: 'sync_state', value: { accountId: 'a', key: 'other', value: 1 } },
    ])
    const rows = await adapter.loadAccount('a')
    expect(rows.identity.map((row) => row.id)).toEqual(['human-1'])
    expect(rows.view.map((row) => row.key)).toEqual(['list-scroll'])
    expect(rows.sync_state.map((row) => row.key)).toEqual(['other'])
    adapter.close()
  })

  it('keeps the revision cursor when every row is current', async () => {
    const adapter = await openLocalSyncDb(new IDBFactory())
    await adapter.commit([{ type: 'put', store: 'sync_state', value: { accountId: 'a', key: 'account-revision-cursor', value: { revision: '9' } } }])
    expect((await adapter.loadAccount('a')).sync_state.map((row) => row.key)).toEqual(['account-revision-cursor'])
    adapter.close()
  })

  it('drops a membership row that is not a group roster row (no member type), so the roster never reads it as a human', async () => {
    const adapter = await openLocalSyncDb(new IDBFactory())
    await adapter.commit([
      { type: 'put', store: 'membership', value: { accountId: 'a', chatId: 'g', identityId: 'agent-1', value: { role: 'member', last_read_seq: 4 } } },
      { type: 'put', store: 'membership', value: { accountId: 'a', chatId: 'g', identityId: 'human-1', value: { role: 'member', type: 'human' } } },
    ])
    expect((await adapter.loadAccount('a')).membership.map((row) => row.identityId)).toEqual(['human-1'])
    adapter.close()
  })
})
