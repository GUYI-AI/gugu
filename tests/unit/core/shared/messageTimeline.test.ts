import { describe, expect, it } from 'vitest'
import { orderMessages } from '@gugu/core/shared/ui/messageTimeline'
import type { MessageItem } from '@gugu/core/shared/types/chat'

const row = (id: string, seq: number, extra: Partial<MessageItem> = {}) =>
  ({ id, seq, is_mine: true, created_at: '2026-11-25T00:00:00.000Z', ...extra }) as MessageItem
const sending = (id: string, afterSeq: number, createdAt: string, extra: Partial<MessageItem> = {}) =>
  row(id, -1, { local_send_state: 'sending', local_timeline: { afterSeq, createdAt }, ...extra })
const ids = (rows: MessageItem[]) => orderMessages(rows).map((item) => item.id)

describe('orderMessages', () => {
  it('keeps a row still sending after the rows this person sent before it, once those are confirmed', () => {
    // A text and two pictures sent together, all placed below seq 10; the text and the first picture are confirmed.
    const rows = [row('old', 10, { is_mine: false }), row('text', 11), row('red', 12), sending('blue', 10, '2026-11-25T00:00:00.003Z')]
    expect(ids(rows)).toEqual(['old', 'text', 'red', 'blue'])
  })

  it('keeps a row still sending where it was sent among other people\'s messages', () => {
    const rows = [row('mine', 10), sending('next', 10, '2026-11-25T00:00:00.001Z'), row('theirs', 11, { is_mine: false })]
    expect(ids(rows)).toEqual(['mine', 'next', 'theirs'])
  })

  it('leaves a failed row at the place it was sent', () => {
    const rows = [row('a', 10), sending('failed', 10, '2026-11-25T00:00:00.001Z', { local_send_state: 'failed' }), row('later', 11)]
    expect(ids(rows)).toEqual(['a', 'failed', 'later'])
  })
})
