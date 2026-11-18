import { phoneTextWordRange } from './phoneTextSelectionRange'

export interface PhoneTextSelectionSource {
  text: string
  start: number
  end: number
  browserRange: Range
  element: HTMLElement
}

type CaretDocument = Document & {
  caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null
}
const EXCLUDED = 'button, svg, script, style, img, video, audio, iframe, object, embed, link, [aria-hidden="true"]'

function textNodes(root: HTMLElement) {
  return root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: node => node.parentElement?.closest(EXCLUDED) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
  })
}

/** A word can cross emphasis/link nodes. Move its UTF-16 endpoints through the original text nodes. */
function browserWordRange(root: HTMLElement, node: Node, offset: number, startDelta: number, endDelta: number): Range {
  const move = (delta: number): [Node, number] => {
    const walker = textNodes(root)
    walker.currentNode = node
    let current = node
    let at = offset
    let remaining = Math.abs(delta)
    while (remaining > 0) {
      const available = delta < 0 ? at : (current.textContent?.length ?? 0) - at
      if (remaining <= available) { at += delta < 0 ? -remaining : remaining; break }
      remaining -= available
      const next = delta < 0 ? walker.previousNode() : walker.nextNode()
      if (!next) { at = delta < 0 ? 0 : current.textContent?.length ?? 0; break }
      current = next
      at = delta < 0 ? current.textContent?.length ?? 0 : 0
    }
    return [current, at]
  }
  const range = root.ownerDocument.createRange()
  range.setStart(...move(startDelta))
  range.setEnd(...move(endDelta))
  return range
}

/** Read the word before the lifted menu hides the original message. */
export function capturePhoneTextSelection(bubble: HTMLElement | null, x: number, y: number): PhoneTextSelectionSource | null {
  if (!bubble) return null
  const root = bubble.querySelector<HTMLElement>('.gg-md') ?? bubble
  const document = root.ownerDocument as CaretDocument
  // WebView hit testing can skip text with user-select:none. Only enable hit testing while reading it.
  const previousStyle = root.getAttribute('style')
  root.style.setProperty('user-select', 'text', 'important')
  root.style.setProperty('-webkit-user-select', 'text', 'important')
  let position: ReturnType<NonNullable<CaretDocument['caretPositionFromPoint']>> | undefined
  let caret: Range | null | undefined
  try {
    position = document.caretPositionFromPoint?.(x, y)
    caret = document.caretRangeFromPoint?.(x, y)
  } finally {
    if (previousStyle === null) root.removeAttribute('style')
    else root.setAttribute('style', previousStyle)
  }
  if (position) {
    caret = document.createRange()
    caret.setStart(position.offsetNode, position.offset)
    caret.collapse(true)
  }
  if (!caret || !root.contains(caret.startContainer) || caret.startContainer.nodeType !== Node.TEXT_NODE) {
    const first = textNodes(root).nextNode()
    if (!first) return null
    caret = document.createRange()
    caret.setStart(first, 0)
    caret.collapse(true)
  }
  const node = caret.startContainer
  const offset = caret.startOffset
  // An offscreen clone preserves innerText's line breaks without touching React's DOM.
  const path: number[] = []
  for (let current: Node = node; current !== root;) {
    const parent = current.parentNode
    if (!parent) return null
    path.unshift(Array.prototype.indexOf.call(parent.childNodes, current))
    current = parent
  }
  const clone = root.cloneNode(true) as HTMLElement
  // Streamdown skips offscreen code blocks. The measuring clone must lay out their real text.
  for (const element of [clone, ...clone.querySelectorAll<HTMLElement>('*')]) {
    element.style.setProperty('content-visibility', 'visible', 'important')
  }
  let copyNode: Node = clone
  for (const index of path) copyNode = copyNode.childNodes[index]
  let marker = 'GUGU_SELECTION_OFFSET'
  while (root.textContent?.includes(marker)) marker += '_'
  const value = copyNode.textContent ?? ''
  copyNode.textContent = value.slice(0, offset) + marker + value.slice(offset)
  for (const control of clone.querySelectorAll(EXCLUDED)) control.remove()
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
    return word ? { text, ...word, browserRange: browserWordRange(root, node, offset, word.start - at, word.end - at), element: root } : null
  } finally {
    host.remove()
    // Chromium may materialize an empty inline style during the measuring layout flush.
    if (previousStyle === null) root.removeAttribute('style')
    else root.setAttribute('style', previousStyle)
  }
}
