import type { MessageItem } from '../types/chat'

/** A sending device's display position; never a delivery/read/history cursor. */
export function captureMessagePosition(rows: readonly MessageItem[], createdAt: string): NonNullable<MessageItem['local_timeline']> {
  return { afterSeq: rows.reduce((seq, row) => Math.max(seq, row.seq, row.local_timeline?.afterSeq ?? 0), 0), createdAt }
}

/** Old outbox records have the original send time, but no sequence anchor. */
export function inferMessagePosition(rows: readonly MessageItem[], createdAt: string): NonNullable<MessageItem['local_timeline']> {
  const preceding = rows.filter(row => row.seq > 0 && Date.parse(row.local_timeline?.createdAt ?? row.created_at) <= Date.parse(createdAt))
  return { afterSeq: preceding.reduce((seq, row) => Math.max(seq, row.local_timeline?.afterSeq ?? row.seq), 0), createdAt }
}

/** Canonical rows retain seq order; locally sent rows keep their original slot after acknowledgement. */
export function orderMessages(rows: readonly MessageItem[]): MessageItem[] {
  return rows.map(row => row.seq < 1 && !row.local_timeline
    ? { ...row, local_timeline: inferMessagePosition(rows, row.created_at) } : row).sort((left, right) => {
    const a = left.local_timeline, b = right.local_timeline
    const position = (a?.afterSeq ?? left.seq) - (b?.afterSeq ?? right.seq)
    if (position) return position
    if (!!a !== !!b) return a ? 1 : -1
    if (a && b && a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0
  })
}
