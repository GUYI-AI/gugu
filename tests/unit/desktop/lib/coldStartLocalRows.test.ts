// @vitest-environment jsdom
// Painted local rows make the list loaded: names, topics and the open conversation draw from them at once, without
// waiting for the account initialization that runs behind the first frame.
import { describe, expect, it } from 'vitest'
import type { ChatItem } from '@gugu/core/shared/types/chat'
import { createMemoryLocalSyncDb } from '../../../../apps/desktop/src/lib/localSyncDb'
import { openImRepository, writeChatRows } from '../../../../apps/desktop/src/lib/imRepository'
import { paintLocalChats } from '../../../../apps/desktop/src/lib/chatSnapshotPublication'
import { chat as chatRow, displayIdentity } from '../../../support/testHarness'

const account = 'account-a'
const chat = chatRow({ id: 'chat-1', kind: 'dm', peer_user_id: 'peer' })
const peer = displayIdentity('peer')

async function storedAdapter() {
  const adapter = createMemoryLocalSyncDb()
  const seed = await openImRepository(account, { adapter })
  await seed.transaction((transaction) => { writeChatRows(seed, transaction, [chat]); transaction.putIdentity(peer) })
  seed.close()
  return adapter
}

function listState() {
  const state = { chats: [] as ChatItem[], load: 'unread' as 'unread' | 'idle' | 'loading' | 'failed' }
  return {
    state,
    list: {
      chatsRef: { current: [] as ChatItem[] }, projection: { seedFromCache: () => undefined },
      setChats: (rows: ChatItem[] | ((current: ChatItem[]) => ChatItem[])) => { state.chats = typeof rows === 'function' ? rows(state.chats) : rows },
      setChatsLoad: (next: typeof state.load | ((current: typeof state.load) => typeof state.load)) => { state.load = typeof next === 'function' ? next(state.load) : next },
    },
  }
}

describe('cold start draws from the stored rows', () => {
  it('stored rows make the list loaded as soon as they are painted; an empty store keeps waiting for the account read', async () => {
    const stored = await openImRepository(account, { adapter: await storedAdapter(), initialize: async () => undefined })
    const painted = listState()
    paintLocalChats(stored, painted.list)
    expect(painted.state.load).toBe('idle')
    stored.close()

    const empty = await openImRepository(account, { adapter: createMemoryLocalSyncDb(), initialize: async () => undefined })
    const waiting = listState()
    paintLocalChats(empty, waiting.list)
    expect(waiting.state).toEqual({ chats: [], load: 'loading' })
    empty.close()
  })
})
