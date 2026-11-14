/** One thing said, as a forward carries it: who said it, what, and the line it answered if it answered one. */
export type ForwardQuoteItem = { sender: string; text: string; replyTo?: { sender: string; text: string } | null }

const REPLY_EXCERPT = 80

/**
 * The text a forward sends: the forwarder's note, then each forwarded thing as a quote headed by who said it.
 * A forward is read where the original chat is not, so the speaker (and the line a reply answered) goes with the words;
 * the source chat's name does not (whoever can read the source sees it on the forwarded badge).
 */
export function forwardQuote(items: readonly ForwardQuoteItem[], note = ''): string {
  if (items.length === 0) throw new Error('forwardQuote needs something to quote')
  const blocks = items.map(item => {
    const lines = [`**${escapeInline(item.sender)}**`, '']
    if (item.replyTo) lines.push(`> **${escapeInline(item.replyTo.sender)}**：${escapeInline(excerpt(item.replyTo.text, REPLY_EXCERPT))}`, '')
    lines.push(...item.text.trim().split('\n'))
    return lines.map(line => line ? `> ${line}` : '>').join('\n')
  })
  const head = note.trim()
  return [...(head ? [head] : []), ...blocks].join('\n\n')
}

/** One line, at most `max` characters. */
export function excerpt(text: string, max: number): string {
  const line = text.replace(/\s+/g, ' ').trim()
  const characters = Array.from(line)
  return characters.length > max ? `${characters.slice(0, max - 1).join('')}…` : line
}

function escapeInline(text: string): string {
  return text.replace(/[\r\n]+/g, ' ').replace(/([\\`*_[\]<>#|~])/g, '\\$1')
}
