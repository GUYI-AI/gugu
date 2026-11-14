/** One captured selection; editing the optional note never replaces the file's selection or editor buffer. */
export function selectionComment({ document: doc, save, labels }) {
  let close = () => {}
  return {
    close: () => close(),
    open({ file, pick, anchor }) {
      close()
      const source = { ...file }
      const captured = { startLine: pick.lines[0], endLine: pick.lines[1], text: pick.text }
      const popup = doc.createElement('div')
      popup.className = 'file-comment-popup'
      const form = doc.createElement('form')
      form.className = 'file-comment-form'
      const input = doc.createElement('input')
      input.type = 'text'
      input.placeholder = labels().commentPlaceholder
      input.setAttribute('aria-label', labels().commentPlaceholder)
      const submit = doc.createElement('button')
      submit.type = 'submit'
      submit.className = 'file-comment-submit primary'
      submit.setAttribute('aria-label', labels().comment)
      const icon = doc.createElement('gugu-icon')
      icon.setAttribute('name', 'check')
      submit.append(icon)
      const error = doc.createElement('div')
      error.className = 'file-comment-error'
      error.setAttribute('role', 'alert')
      error.hidden = true
      form.append(input, submit)
      popup.append(form, error)
      doc.body.append(popup)
      let busy = false
      const place = () => {
        const at = anchor?.()
        if (!at) return close()
        const gap = 8
        popup.style.left = `${Math.max(gap, Math.min(at.left, doc.defaultView.innerWidth - popup.offsetWidth - gap))}px`
        popup.style.top = `${at.bottom + gap + popup.offsetHeight <= doc.defaultView.innerHeight ? at.bottom + gap : Math.max(gap, at.top - gap - popup.offsetHeight)}px`
      }
      const outside = event => { if (!busy && !popup.contains(event.target)) close() }
      const key = event => { if (event.key === 'Escape' && !busy) { event.preventDefault(); event.stopPropagation(); close() } }
      const selection = doc.getSelection()
      const range = selection?.rangeCount && !selection.isCollapsed ? selection.getRangeAt(0).cloneRange() : null
      const highlights = doc.defaultView.CSS?.highlights
      const highlight = range && doc.defaultView.Highlight ? new doc.defaultView.Highlight(range) : null
      if (highlight) highlights?.set('files-comment', highlight)
      close = () => {
        popup.remove()
        doc.removeEventListener('pointerdown', outside, true)
        doc.removeEventListener('keydown', key, true)
        doc.removeEventListener('scroll', place, true)
        if (highlight && highlights?.get('files-comment') === highlight) highlights.delete('files-comment')
        close = () => {}
      }
      form.onsubmit = async event => {
        event.preventDefault()
        if (busy) return
        busy = true
        submit.disabled = true
        error.hidden = true
        try {
          // No await before this call: the host verifies the actual submit gesture.
          await save(source, { ...captured, annotation: input.value })
          close()
        } catch {
          error.textContent = labels().commentFailed
          error.hidden = false
          popup.dataset.failed = ''
          place()
        } finally { busy = false; submit.disabled = false }
      }
      input.onkeydown = event => { if (event.key === 'Enter' && (event.isComposing || event.keyCode === 229)) event.preventDefault() }
      doc.addEventListener('pointerdown', outside, true)
      doc.addEventListener('keydown', key, true)
      doc.addEventListener('scroll', place, true)
      place()
      input.focus({ preventScroll: true })
    },
  }
}

/** Select source lines through the editor's own document and selection, with no parallel text buffer. */
export function annotationLineNumbers(cm) {
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
    const text = end ? prefix.toString().replace(/\r?\n$/, '') : prefix.toString()
    return Math.min(Number(span[2]), Number(span[1]) + (text.match(/\n/g)?.length ?? 0))
  }
  const first = at(range.startContainer, range.startOffset, false)
  const last = at(range.endContainer, range.endOffset, true)
  return first && last ? [first, last] : null
}
