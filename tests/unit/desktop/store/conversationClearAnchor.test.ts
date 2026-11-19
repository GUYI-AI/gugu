import { describe, expect, it } from 'vitest'
import { ChatWindowCache } from '../../../../apps/desktop/src/store/chatWindowCache'
import { message } from '../../../support/testHarness'

const old = (seq = 10) => message({ id: `old-${seq}`, chat_id: 'chat', seq, created_at: '2026-11-19T00:00:00Z' })
const fresh = (seq = 20) => message({ id: `fresh-${seq}`, chat_id: 'chat', seq, created_at: '2026-11-19T00:02:00Z' })
const floor = '2026-11-19T00:01:00Z'

describe('personal clear after a search/history anchor', () => {
  it.each([false, true])('shows the next message without a manual return to latest (mine=%s)', async isMine => {
    const cache = new ChatWindowCache('me'), viewport = {}
    cache.set('chat', [old()])
    const stop = cache.subscribe('chat', () => undefined, undefined, viewport)
    const window = cache.history('chat', viewport)
    await window.restoreAnchor(async () => ({ messages: [old()], hasNewer: true }))
    cache.clearHistoryBefore('chat', floor)
    cache.set('chat', [{ ...fresh(), is_mine: isMine }])
    expect(window.getSnapshot().messages.map(row => row.id)).toEqual(['fresh-20'])
    expect(window.getSnapshot().hasNewer).toBe(false)
    expect(window.isFollowingTail()).toBe(true)
    stop()
  })

  it('rejects an anchor response started before clear instead of reopening an empty historical range', async () => {
    const cache = new ChatWindowCache('me'), viewport = {}
    cache.set('chat', [old()])
    const stop = cache.subscribe('chat', () => undefined, undefined, viewport)
    const window = cache.history('chat', viewport)
    let complete!: (result: { messages: ReturnType<typeof old>[]; hasNewer: boolean }) => void
    const pending = window.restoreAnchor(() => new Promise(resolve => { complete = resolve }))
    cache.clearHistoryBefore('chat', floor)
    cache.set('chat', [fresh()])
    complete({ messages: [old()], hasNewer: true })
    expect(await pending).toBe(false)
    expect(window.getSnapshot().messages.map(row => row.id)).toEqual(['fresh-20'])
    stop()
  })

  it('keeps an unsent outbox row when its persisted anchor is cleared', async () => {
    const cache = new ChatWindowCache('me'), viewport = {}
    const pending = message({ id: 'pending', chat_id: 'chat', seq: -1, created_at: '2026-11-19T00:00:00Z', is_mine: true, local_send_state: 'sending' })
    cache.set('chat', [old(), pending])
    const stop = cache.subscribe('chat', () => undefined, undefined, viewport)
    const window = cache.history('chat', viewport)
    await window.restoreAnchor(async () => ({ messages: [old()], hasNewer: true }))
    cache.clearHistoryBefore('chat', floor)
    expect(window.getSnapshot().messages.map(row => row.id)).toEqual(['pending'])
    expect(window.isFollowingTail()).toBe(true)
    cache.set('chat', [fresh()])
    expect(new Set(window.getSnapshot().messages.map(row => row.id))).toEqual(new Set(['pending', 'fresh-20']))
    stop()
  })

  it('preserves an independently valid post-clear history range', async () => {
    const cache = new ChatWindowCache('me'), viewport = {}
    cache.set('chat', [old(), fresh(20), fresh(30)])
    const stop = cache.subscribe('chat', () => undefined, undefined, viewport)
    const window = cache.history('chat', viewport)
    await window.restoreAnchor(async () => ({ messages: [fresh(20)], hasNewer: true }))
    const navigation = window.getSnapshot().navigationVersion
    cache.clearHistoryBefore('chat', floor)
    cache.set('chat', [fresh(40)])
    expect(window.getSnapshot().messages.map(row => row.id)).toEqual(['fresh-20'])
    expect(window.getSnapshot().navigationVersion).toBe(navigation)
    expect(window.getSnapshot().hasNewer).toBe(true)
    stop()
  })
})
