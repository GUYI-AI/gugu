/** Select source lines through the editor's own document and selection, with no parallel text buffer. */
export function lineNumberSelection(cm) {
  let anchor = null, dragging = false
  const select = (view, block, event) => {
    const line = view.state.doc.lineAt(block.from).number
    if (!dragging) anchor = event.shiftKey ? anchor ?? view.state.doc.lineAt(view.state.selection.main.anchor).number : line
    const first = view.state.doc.line(Math.min(anchor, line))
    const last = view.state.doc.line(Math.max(anchor, line))
    view.dispatch({ selection: { anchor: first.from, head: last.to } })
    view.focus()
    return true
  }
  return cm.view.lineNumbers({ domEventHandlers: {
    mousedown(view, block, event) { if (event.button !== 0) return false; event.preventDefault(); select(view, block, event); dragging = true; return true },
    mousemove(view, block, event) { if (!dragging || event.buttons !== 1) { dragging = false; return false } return select(view, block, event) },
    mouseup() { dragging = false; return false },
  } })
}

/** Soft line breaks remain text nodes in the preview; count only within its marked source block. */
export function previewSelectionLines(range) {
  if (!range || range.collapsed) return null
  const at = (node, offset, end) => {
    const block = (node.nodeType === 1 ? node : node.parentElement)?.closest('[data-line]')
    const span = /^(\d+)-(\d+)$/.exec(block?.dataset.line ?? '')
    if (!block || !span) return null
    const prefix = block.ownerDocument.createRange()
    prefix.selectNodeContents(block)
    prefix.setEnd(node, offset)
    // Chromium's paragraph selection can end at the next block's first text node, before any of its characters.
    if (end && !prefix.toString()) {
      const root = block.closest('.gg-md') ?? block.parentElement
      let before = block
      while (before && before !== root) {
        if (!before.previousElementSibling) { before = before.parentElement; continue }
        before = before.previousElementSibling
        const last = [...before.querySelectorAll('[data-line]')].at(-1) ?? before
        const previous = /^(\d+)-(\d+)$/.exec(last.dataset.line ?? '')
        if (previous) return Number(previous[2])
      }
    }
    const text = end ? prefix.toString().replace(/\r?\n$/, '') : prefix.toString()
    return Math.min(Number(span[2]), Number(span[1]) + (text.match(/\n/g)?.length ?? 0))
  }
  const first = at(range.startContainer, range.startOffset, false)
  const last = at(range.endContainer, range.endOffset, true)
  return first && last ? [first, last] : null
}

/** The words of a preview selection: a formula once, as its TeX (`$…$`), not its drawing and its hidden source both. */
export function previewSelectionText(range) {
  const words = range.cloneContents()
  for (const math of words.querySelectorAll('.katex')) {
    // gugu's own drawing keeps the TeX as the hidden part's text; KaTeX's MathML keeps it in an annotation.
    const source = math.querySelector('.katex-mathml')
    const tex = source?.querySelector('annotation[encoding="application/x-tex"]')?.textContent ?? source?.textContent
    if (tex) math.replaceWith(math.closest('.katex-display') ? `$$${tex}$$` : `$${tex}$`)
  }
  for (const source of words.querySelectorAll('.katex-mathml')) source.remove()
  return words.textContent
}
