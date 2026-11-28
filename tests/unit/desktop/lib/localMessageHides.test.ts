// @vitest-environment jsdom
// @@@local-hide - delete and clear hide on this device only: no server call, the message store is the only record and
// refuses the hidden rows when the server sends them again; logout empties it and they come back.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { messageItemFromRow } from '@gugu/core/cloud/messageItem'
import { createLocalMessageStore } from '../../../../apps/desktop/src/lib/localMessageStore'
import { clearChatWrites, hideMessageWrites, localHidesOf, newestShown } from '../../../../apps/desktop/src/lib/localMessageHides'

afterEach(() => { vi.unstubAllGlobals() })
const row = (owner: string, id: string, seq: number, created_at: string) =>
  messageItemFromRow({ id, chat_id: 'room', seq, sender_user_id: 'peer', content_type: 'text', content: id, created_at }, owner)!

describe('local message hides', () => {
  it('clears through the newest shown message, to the microsecond', () => {
    expect(hideMessageWrites('room', 'm1')).toEqual([{ type: 'delete', chatId: 'room', id: 'm1' }])
    const through = newestShown([{ seq: 1, created_at: '2026-11-28T06:51:00.123456+00:00' }, { seq: -1, created_at: '2099-01-01T00:00:00Z' }], null)
    expect(through).toBe('2026-11-28T06:51:00.123456+00:00')
    const clear = clearChatWrites('room', through!)
    expect(clear).toEqual([{ type: 'chatAccess', access: { chatId: 'room', clearedAt: '2026-11-28T06:51:00.123457Z' } }])
    expect(localHidesOf([...hideMessageWrites('room', 'm1'), ...clear])).toEqual([{ chatId: 'room', ids: ['m1'], clearedAt: '2026-11-28T06:51:00.123457Z' }])
  })

  it('lives in the store: refused on arrival, answered by hidden, gone after logout', async () => {
    vi.stubGlobal('indexedDB', new IDBFactory()); vi.stubGlobal('IDBKeyRange', IDBKeyRange)
    const owner = crypto.randomUUID()
    const store = createLocalMessageStore()
    const rows = [row(owner, 'm1', 1, '2026-11-28T00:00:01Z'), row(owner, 'm2', 2, '2026-11-28T00:00:02Z'), row(owner, 'm3', 3, '2026-11-28T00:00:03Z')]
    const fromServer = { writes: rows.map(message => ({ type: 'put' as const, message })), revisions: [] }
    await store.ingest(owner, { writes: [{ type: 'chatAccess', access: { chatId: 'room', ownMember: true } }], revisions: [] })
    await store.ingest(owner, fromServer)
    await store.ingest(owner, { writes: [...hideMessageWrites('room', 'm3'), ...clearChatWrites('room', '2026-11-28T00:00:01Z')], revisions: [] })
    expect((await store.ingest(owner, fromServer)).map(write => write.type === 'put' && write.message.id)).toEqual(['m2'])
    expect((await store.windows(owner, ['room'], 10)).map(message => message.id)).toEqual(['m2'])
    expect(await store.hidden(owner, rows)).toEqual(['m1', 'm3'])

    await store.clearAccount(owner)
    await store.ingest(owner, fromServer)
    expect((await store.windows(owner, ['room'], 10)).map(message => message.id)).toEqual(['m1', 'm2', 'm3'])
    expect(await store.hidden(owner, rows)).toEqual([])
    store.close()
  })
})
