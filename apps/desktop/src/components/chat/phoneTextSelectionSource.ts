import { phoneTextWordRange } from './phoneTextSelectionRange'

export interface PhoneTextSelectionSource {
  text: string
  start: number
  end: number
  browserRange: Range
}

type CaretDocument = Document & {
  caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null
}

/** Read the word before the lifted menu hides the original message. */
export function capturePhoneTextSelection(bubble: HTMLElement | null, x: number, y: number): PhoneTextSelectionSource | null {
  if (!bubble) return null
  const root = bubble.querySelector<HTMLElement>('.gg-md') ?? bubble
  const document = root.ownerDocument as CaretDocument
  const position = document.caretPositionFromPoint?.(x, y)
  let caret = document.caretRangeFromPoint?.(x, y)
  if (position) {
    caret = document.createRange()
    caret.setStart(position.offsetNode, position.offset)
    caret.collapse(true)
  }
  if (!caret || !root.contains(caret.startContainer) || caret.startContainer.nodeType !== Node.TEXT_NODE) {
    const first = document.createTreeWalker(root, NodeFilter.SHOW_TEXT).nextNode()
    if (!first) return null
    caret = document.createRange()
    caret.setStart(first, 0)
    caret.collapse(true)
  }
  const node = caret.startContainer
  const offset = caret.startOffset
  const local = phoneTextWordRange(node.textContent ?? '', offset)
  if (!local) return null
  const browserRange = document.createRange()
  browserRange.setStart(node, local.start)
  browserRange.setEnd(node, local.end)

  // An offscreen clone preserves innerText's line breaks without touching React's DOM.
  const path: number[] = []
  for (let current: Node = node; current !== root;) {
    const parent = current.parentNode
    if (!parent) return null
    path.unshift(Array.prototype.indexOf.call(parent.childNodes, current))
    current = parent
  }
  const clone = root.cloneNode(true) as HTMLElement
  let copyNode: Node = clone
  for (const index of path) copyNode = copyNode.childNodes[index]
  let marker = 'GUGU_SELECTION_OFFSET'
  while (root.textContent?.includes(marker)) marker += '_'
  const value = copyNode.textContent ?? ''
  copyNode.textContent = value.slice(0, offset) + marker + value.slice(offset)
  for (const control of clone.querySelectorAll('button, svg, script, style, [aria-hidden="true"]')) control.remove()
  for (const element of [clone, ...clone.querySelectorAll('[id], [data-testid]')]) {
    element.removeAttribute('id')
    element.removeAttribute('data-testid')
  }
  const host = document.createElement('div')
  host.setAttribute('aria-hidden', 'true')
  host.inert = true
  Object.assign(host.style, { position: 'fixed', left: '-100000px', top: '0', width: `${root.getBoundingClientRect().width}px`, opacity: '0', pointerEvents: 'none' })
  host.append(clone)
  document.body.append(host)
  try {
    const rendered = clone.innerText ?? clone.textContent ?? ''
    const at = rendered.indexOf(marker)
    if (at < 0) return null
    const text = rendered.slice(0, at) + rendered.slice(at + marker.length)
    const word = phoneTextWordRange(text, at)
    return word ? { text, ...word, browserRange } : null
  } finally {
    host.remove()
  }
}
