// @vitest-environment jsdom
// @@@local-hide - delete and clear hide on this device only: no server call, the intent outlives logout, and the
// message store refuses the hidden rows when the server sends them again.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { messageItemFromRow } from '@gugu/core/cloud/messageItem'
import { createLocalMessageStore } from '../../../../apps/desktop/src/lib/localMessageStore'

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); localStorage.clear() })
const hidesModule = () => import('../../../../apps/desktop/src/lib/localMessageHides')
const row = (owner: string, id: string, seq: number, created_at: string) =>
  messageItemFromRow({ id, chat_id: 'room', seq, sender_user_id: 'peer', content_type: 'text', content: id, created_at }, owner)!

describe('local message hides', () => {
  it('hides one message and clears through the newest shown message, to the microsecond', async () => {
    const { hideMessageLocally, clearChatLocally, isMessageHidden, newestShown } = await hidesModule()
    const owner = crypto.randomUUID()
    expect(hideMessageLocally(owner, 'room', 'm1')).toEqual([{ type: 'delete', chatId: 'room', id: 'm1' }])
    expect(isMessageHidden(owner, { id: 'm1', chat_id: 'room', created_at: '2026-11-28T00:00:00Z' })).toBe(true)
    expect(isMessageHidden(owner, { id: 'm1', chat_id: 'other', created_at: '2026-11-28T00:00:00Z' })).toBe(false)

    const through = newestShown([{ seq: 1, created_at: '2026-11-28T06:51:00.123456+00:00' }, { seq: -1, created_at: '2099-01-01T00:00:00Z' }], null)
    expect(through).toBe('2026-11-28T06:51:00.123456+00:00')
    expect(clearChatLocally(owner, 'room', through!)).toEqual([{ type: 'chatAccess', access: { chatId: 'room', clearedAt: '2026-11-28T06:51:00.123457Z' } }])
    expect(isMessageHidden(owner, { id: 'old', chat_id: 'room', created_at: '2026-11-28T06:51:00.123456+00:00' })).toBe(true)
    expect(isMessageHidden(owner, { id: 'new', chat_id: 'room', created_at: '2026-11-28T06:51:00.123457+00:00' })).toBe(false)
    // An older clear never moves the cutoff back.
    clearChatLocally(owner, 'room', '2026-11-27T00:00:00Z')
    expect(isMessageHidden(owner, { id: 'old', chat_id: 'room', created_at: '2026-11-28T06:51:00.123456+00:00' })).toBe(true)
  })

  it('keeps hides across a reload and writes them back into a store that logout emptied', async () => {
    vi.stubGlobal('indexedDB', new IDBFactory()); vi.stubGlobal('IDBKeyRange', IDBKeyRange)
    const owner = crypto.randomUUID()
    const first = await hidesModule()
    const store = createLocalMessageStore()
    const rows = [row(owner, 'm1', 1, '2026-11-28T00:00:01Z'), row(owner, 'm2', 2, '2026-11-28T00:00:02Z'), row(owner, 'm3', 3, '2026-11-28T00:00:03Z')]
    const fromServer = { writes: rows.map(message => ({ type: 'put' as const, message })), revisions: [] }
    await store.ingest(owner, { writes: [{ type: 'chatAccess', access: { chatId: 'room', ownMember: true } }], revisions: [] })
    await store.ingest(owner, fromServer)
    await store.ingest(owner, { writes: [...first.hideMessageLocally(owner, 'room', 'm3'), ...first.clearChatLocally(owner, 'room', '2026-11-28T00:00:01Z')], revisions: [] })
    await store.ingest(owner, fromServer)
    expect((await store.windows(owner, ['room'], 10)).map(message => message.id)).toEqual(['m2'])

    await store.clearAccount(owner)
    vi.resetModules()
    const reloaded = await hidesModule()
    await store.ingest(owner, { writes: reloaded.localHideWrites(owner), revisions: [] })
    await store.ingest(owner, fromServer)
    expect((await store.windows(owner, ['room'], 10)).map(message => message.id)).toEqual(['m2'])
    store.close()
  })
})
