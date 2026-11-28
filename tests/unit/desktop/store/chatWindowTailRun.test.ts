import { describe, expect, it } from 'vitest'
import { message } from '../../../support/testHarness'
import { ChatWindowCache } from '../../../../apps/desktop/src/store/chatWindowCache'

const rows = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, index) =>
  message({ id: `m${from + index}`, chat_id: 'room', seq: from + index, sender_user_id: 'peer' }))
const seqs = (cache: ChatWindowCache) => cache.view('room').messageWindow.messages.map(row => row.seq)

// The store publishes each conversation's verified tail run (im-message-store `windows`).
describe('a window and the published tail run', () => {
  it('follows the run: rows below it leave, because nothing connects them to it', () => {
    const cache = new ChatWindowCache('viewer')
    const stop = cache.subscribe('room', () => undefined)
    cache.publishTail('room', rows(1, 10))
    cache.publishTail('room', rows(1, 12))
    expect(seqs(cache)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
    cache.publishTail('room', rows(500, 505))
    expect(seqs(cache)).toEqual([500, 501, 502, 503, 504, 505])
    expect(cache.view('room').messageWindow.hasOlder).toBe(true)
    stop()
  })

  it('keeps an unsent row and leaves a reader in history where they are, with newer rows announced', () => {
    const cache = new ChatWindowCache('viewer')
    const viewport = {}
    const stop = cache.subscribe('room', () => undefined, undefined, viewport)
    cache.publishTail('room', rows(1, 10))
    cache.update('room', previous => [...previous, message({ id: 'unsent', chat_id: 'room', seq: -1, sender_user_id: 'viewer' })])
    cache.publishTail('room', rows(500, 505))
    expect(cache.view('room', viewport).messageWindow.messages.map(row => row.id)).toContain('unsent')
    expect(cache.view('room', viewport).messageWindow.messages.filter(row => row.seq > 0).map(row => row.seq)).toEqual([500, 501, 502, 503, 504, 505])

    const reader = new ChatWindowCache('viewer')
    const reading = {}
    const stopReader = reader.subscribe('room', () => undefined, undefined, reading)
    reader.publishTail('room', rows(1, 10))
    reader.setFollowingTail('room', reading, false)
    reader.publishTail('room', rows(500, 505))
    expect(reader.view('room', reading).messageWindow.messages.map(row => row.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    expect(reader.view('room', reading).messageWindow.hasNewer).toBe(true)
    stop(); stopReader()
  })
})
