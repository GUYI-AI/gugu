import { MessageSquare } from '@/lib/icons'

/** A topic's face (第 16 版设计稿): a round warm disc with the message glyph, where a group or person shows an avatar. */
export function TopicMark({ size, glyph = Math.round(size / 2) }: { size: number; glyph?: number }) {
  return (
    <span aria-hidden className="grid shrink-0 place-items-center rounded-full bg-[var(--topic-mark-bg)] text-[var(--topic-mark-fg)]" style={{ width: size, height: size }}>
      <MessageSquare size={glyph} />
    </span>
  )
}
