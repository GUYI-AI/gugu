// @vitest-environment jsdom
// #7199
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createReactHarness, deferred, message } from '../../../support/testHarness'
import { chatService } from '../../../../apps/desktop/src/lib/chat'
import { openImRepository } from '../../../../apps/desktop/src/lib/imRepository'
import { ingestMessages } from '../../../../apps/desktop/src/lib/messageIngest'
import { createMemoryLocalSyncDb } from '../../../../apps/desktop/src/lib/localSyncDb'
import { openCachedChatWindow, useChatWindowCache } from '../../../../apps/desktop/src/store/chatWindowPublication'

let harness: ReturnType<typeof createReactHarness>
let first: ReturnType<typeof useChatWindowCache>, second: ReturnType<typeof useChatWindowCache>
function CacheOwner({ index }: { index: number }) {
  const value = useChatWindowCache()
  if (index === 1) first = value
  else second = value
  return null
}
beforeEach(() => { harness = createReactHarness() })
afterEach(() => harness.cleanup())
describe('shared message cache publication', () => {
  it('replays existing rows and publishes updates and removal without a second cache', async () => {
    await harness.render(<CacheOwner index={1} />)
    const rows = [message({ chat_id: 'task' })]
    first.cache.set('task', rows)
    const observe = vi.fn()
    const stop = first.subscribeChatWindow('task', observe)
    expect(observe).toHaveBeenLastCalledWith(rows)
    first.cache.set('other', [])
    expect(observe).toHaveBeenCalledTimes(1)
    first.cache.delete('task')
    expect(observe).toHaveBeenLastCalledWith([])
    first.cache.set('task', rows)
    first.cache.clear()
    expect(observe).toHaveBeenLastCalledWith([])
    stop(); observe.mockClear()
    first.cache.set('task', rows)
    expect(observe).not.toHaveBeenCalled()
  })
  it('does not publish another account provider’s cache into this pane', async () => {
    await harness.render(<><CacheOwner index={1} /><CacheOwner index={2} /></>)
    const observe = vi.fn()
    const stop = first.subscribeChatWindow('task', observe)
    observe.mockClear()
    second.cache.set('task', [message({ chat_id: 'task' })])
    expect(observe).not.toHaveBeenCalled()
    stop()
  })
  it('publishes cold bodies while watermarks and overlays are still pending', async () => {
    await harness.render(<CacheOwner index={1} />)
    const body = deferred<ReturnType<typeof message>[]>()
    const watermarks = deferred<Record<string, number>>()
    const overlays = deferred<void>()
    vi.spyOn(chatService, 'getMessages').mockImplementation(() => body.promise)
    vi.spyOn(chatService, 'getOtherMembersReadSeqs').mockImplementation(() => watermarks.promise)
    const repository = await openImRepository('user', { adapter: createMemoryLocalSyncDb() })
    const ready = vi.fn(), readSeqs = vi.fn()
    const read = openCachedChatWindow({
      chatId: 'topic', userId: 'user', cache: first.cache, history: first.cache.history('topic'), getRepository: async () => repository,
      expectedTailSeq: null, hasPositiveUnread: false,
      observer: { current: () => true, painted: vi.fn(), ready, readSeqs },
      commit: (rows) => { first.cache.set('topic', rows) },
      revalidate: () => overlays.promise,
    })
    await Promise.resolve()
    const rows = [message({ chat_id: 'topic' })]
    body.resolve(rows)
    await vi.waitFor(() => expect(ready).toHaveBeenCalled())
    expect(first.cache.get('topic')).toEqual(rows)
    expect(readSeqs).not.toHaveBeenCalled()
    watermarks.resolve({ peer: 1 }); overlays.resolve()
    await read
    expect(readSeqs).toHaveBeenCalledWith({ peer: 1 })
    repository.close()
  })

  it('paints an unopened account arrival before fetching a complete tail for its sparse range', async () => {
    await harness.render(<CacheOwner index={1} />)
    const repository = await openImRepository('user', { adapter: createMemoryLocalSyncDb() })
    const arrival = message({ id: 'arrived-while-closed', chat_id: 'topic', seq: 100 })
    await ingestMessages('user', { writes: [], revisions: [{ revision: '1', writes: [{ type: 'put', message: arrival }] }] })
    const body = deferred<ReturnType<typeof message>[]>()
    const readMessages = vi.spyOn(chatService, 'getMessages').mockImplementation(() => body.promise)
    vi.spyOn(chatService, 'getOtherMembersReadSeqs').mockResolvedValue({})
    const painted = vi.fn()
    const read = openCachedChatWindow({
      chatId: 'topic', userId: 'user', cache: first.cache, history: first.cache.history('topic'), getRepository: async () => repository,
      expectedTailSeq: 100, hasPositiveUnread: true,
      observer: { current: () => true, painted, ready: vi.fn(), readSeqs: vi.fn() },
      commit: rows => { first.cache.set('topic', rows) }, revalidate: async () => {},
    })
    // What paints is the stored row: the store keeps no renderer-only fields (local_send_*).
    const { local_send_state: _local, ...stored } = arrival
    await vi.waitFor(() => expect(painted).toHaveBeenCalledWith([stored], true))
    expect(readMessages).toHaveBeenCalledWith('topic', 'user', 'initialLoad', 30)
    expect(first.cache.rows('topic')).toEqual([stored])
    body.resolve([arrival]); await read; repository.close()
  })

})
