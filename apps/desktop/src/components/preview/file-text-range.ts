export interface FileTextRange {
  startLine: number
  endLine: number
  text: string
}

/** A saved range is independent of browser selection, which focusing the comment input clears. */
export type FileTextComment = FileTextRange & { annotation: string }

function codeRow(node: Text): Element | null {
  const code = node.parentElement?.closest('[data-streamdown="code-block-body"] code')
  if (!code) return null
  let row = node.parentElement
  while (row && row.parentElement !== code) row = row.parentElement
  return row
}

function lineAt(node: Text, offset: number): number | null {
  const source = node.parentElement?.closest<HTMLElement>('[data-file-source-start]')
  if (!source) return null
  const first = Number(source.dataset.fileSourceStart)
  const last = Number(source.dataset.fileSourceEnd ?? first)
  if (!Number.isInteger(first) || first < 1 || !Number.isInteger(last) || last < first) return null
  const row = source.hasAttribute('data-file-source-code') ? codeRow(node) : null
  // The highlighter paints one block span per line, without newline text nodes between those spans.
  if (row?.parentElement) return Math.min(last, first + Array.from(row.parentElement.children).indexOf(row))
  const before = node.ownerDocument.createRange()
  before.selectNodeContents(source)
  before.setEnd(node, offset)
  return Math.min(last, first + (before.toString().match(/\n/g)?.length ?? 0))
}

/** Read DOM endpoints, never search for a quote (identical paragraphs can occur on different source lines). */
export function fileTextRange(root: HTMLElement, range: Range, content: string, kind: 'text' | 'markdown'): FileTextRange | null {
  if (range.collapsed || !root.contains(range.startContainer) || !root.contains(range.endContainer)) return null
  const scope = range.commonAncestorContainer
  const walker = root.ownerDocument.createTreeWalker(scope, NodeFilter.SHOW_TEXT)
  let first: number | null = null, last: number | null = null
  let selectedText = '', previousRow: Element | null = null
  for (let node: Node | null = scope.nodeType === Node.TEXT_NODE ? scope : walker.nextNode(); node; node = walker.nextNode()) {
    const text = node as Text
    if (!text.length || !range.intersectsNode(text)) continue
    const start = range.startContainer === text ? range.startOffset : 0
    const end = range.endContainer === text ? range.endOffset : text.length
    if (start >= end) continue
    const row = codeRow(text)
    if (row && previousRow && row !== previousRow) selectedText += '\n'
    selectedText += text.data.slice(start, end)
    previousRow = row
    const from = lineAt(text, start), to = lineAt(text, end - 1)
    if (from !== null && to !== null) { first ??= from; last = to }
  }
  if (first === null || last === null) return null
  const lines = content.split(/\r?\n/)
  if (first > lines.length || last > lines.length) return null
  const selected = kind === 'text' ? lines.slice(first - 1, last).join('\n') : selectedText
  return kind === 'text' || selected.trim() ? { startLine: first, endLine: last, text: selected } : null
}

export function sourceLineRange(content: string, from: number, to: number): FileTextRange {
  const startLine = Math.min(from, to), endLine = Math.max(from, to)
  return { startLine, endLine, text: content.split(/\r?\n/).slice(startLine - 1, endLine).join('\n') }
}
