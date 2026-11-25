import type { MessageItem } from '../types/chat'

/** A sending device's display position; never a delivery/read/history cursor. */
export function captureMessagePosition(rows: readonly MessageItem[], createdAt: string): NonNullable<MessageItem['local_timeline']> {
  return { afterSeq: rows.reduce((seq, row) => Math.max(seq, row.seq, row.local_timeline?.afterSeq ?? 0), 0), createdAt }
}

// Only an unconfirmed row has a local position; one the outbox has not positioned yet is the newest thing here: it goes last.
// A row still sending is also after every row this person has confirmed since: a chat's sends go out in order, so
// those were sent before it (a text, then the pictures after it, must not swap while the later ones are on their way).
// A failed row keeps the place it was sent at.
function positionOf(rows: readonly MessageItem[]) {
  const mine = rows.reduce((seq, row) => row.is_mine && row.seq > seq ? row.seq : seq, 0)
  return (row: MessageItem) => {
    if (row.seq >= 1) return undefined
    const at = row.local_timeline ?? { afterSeq: Infinity, createdAt: row.created_at }
    return row.local_send_state === 'failed' || at.afterSeq >= mine ? at : { ...at, afterSeq: mine }
  }
}

/** Confirmed rows are in seq order on every device; an unconfirmed row sits after the seq it was sent below. */
export function orderMessages(rows: readonly MessageItem[]): MessageItem[] {
  const position = positionOf(rows)
  return [...rows].sort((left, right) => {
    const a = position(left), b = position(right)
    const order = (a?.afterSeq ?? left.seq) - (b?.afterSeq ?? right.seq)
    if (order) return order
    if (!!a !== !!b) return a ? 1 : -1
    if (a && b && a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0
  })
}
