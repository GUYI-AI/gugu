import type { MessageItem } from '../types/chat'

/** A sending device's display position; never a delivery/read/history cursor. */
export function captureMessagePosition(rows: readonly MessageItem[], createdAt: string): NonNullable<MessageItem['local_timeline']> {
  return { afterSeq: rows.reduce((seq, row) => Math.max(seq, row.seq, row.local_timeline?.afterSeq ?? 0), 0), createdAt }
}

// Only an unconfirmed row has a local position; one the outbox has not positioned yet is the newest thing here: it goes last.
const position = (row: MessageItem) => row.seq < 1 ? row.local_timeline ?? { afterSeq: Infinity, createdAt: row.created_at } : undefined

/** Confirmed rows are in seq order on every device; an unconfirmed row sits after the seq it was sent below. */
export function orderMessages(rows: readonly MessageItem[]): MessageItem[] {
  return [...rows].sort((left, right) => {
    const a = position(left), b = position(right)
    const order = (a?.afterSeq ?? left.seq) - (b?.afterSeq ?? right.seq)
    if (order) return order
    if (!!a !== !!b) return a ? 1 : -1
    if (a && b && a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0
  })
}
