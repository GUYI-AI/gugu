// The outline of a document being read (owner 11-14, as Feishu has it: 「长文档很难读和跳转」): its h1–h3, in the room
// beside the reading column. A press scrolls to that heading; while the page scrolls, the section being read is marked.
// Drawn from the preview's own headings, after each render — no parse of its own, so it lists what is on the page.
// Where it is shown and how it folds (a rail of short lines where the room is too narrow) is the stylesheet's.

const HEADINGS = ':scope > .gg-md > :is(h1, h2, h3)'
/** Fewer headings than this, and the document is short enough to read without one. */
const MIN_ITEMS = 3
/** A heading this close under the reading pane's top edge already starts the section being read. */
const READ_LINE = 24

/** A heading's words as a reader sees them: KaTeX draws a formula twice (its MathML for screen readers, and the glyphs,
 *  with zero-width spaces between). */
function wordsOf(heading) {
  const copy = heading.cloneNode(true)
  for (const hidden of copy.querySelectorAll('.katex-mathml')) hidden.remove()
  return copy.textContent.replace(/\u200b/g, '').replace(/\s+/g, ' ').trim()
}

/**
 * The headings an outline lists: a document's opening h1, when it is its only one, is its title — the outline is of
 * what comes under it. `null` where there are too few to be worth one.
 */
export function outlineOf(preview) {
  let headings = [...preview.querySelectorAll(HEADINGS)]
  const h1s = headings.filter((heading) => heading.tagName === 'H1')
  if (h1s.length === 1 && headings[0] === h1s[0]) headings = headings.slice(1)
  if (headings.length < MIN_ITEMS) return null
  const top = Math.min(...headings.map((heading) => Number(heading.tagName[1])))
  return headings.map((heading) => ({ heading, depth: Number(heading.tagName[1]) - top, text: wordsOf(heading) }))
}

/** The outline in `nav`, of the document `preview` scrolls. */
export function mountOutline(nav, preview) {
  let items = []
  let at = -1
  // A press's heading stays marked while the page scrolls to it, and after.
  let pinned = false
  let frame = 0

  const mark = (index) => {
    if (index === at) return
    items[at]?.button.removeAttribute('aria-current')
    at = index
    const button = items[at]?.button
    if (!button) return
    button.setAttribute('aria-current', 'location')
    // A long outline scrolls itself, so the marked line stays in it (not scrollIntoView: that would move the page too).
    if (button.offsetTop < nav.scrollTop) nav.scrollTop = button.offsetTop
    else if (button.offsetTop + button.offsetHeight > nav.scrollTop + nav.clientHeight) nav.scrollTop = button.offsetTop + button.offsetHeight - nav.clientHeight
  }

  // The section being read: the last heading at or above the read line; scrolled to the very end, the last one in view.
  const follow = () => {
    frame = 0
    // Not drawn (editing; the page not shown yet): nothing on screen to follow.
    if (pinned || items.length === 0 || preview.clientHeight === 0) return
    const pane = preview.getBoundingClientRect()
    const atEnd = preview.scrollTop > 0 && preview.scrollTop + preview.clientHeight >= preview.scrollHeight - 2
    const line = atEnd ? pane.bottom : pane.top + READ_LINE
    let index = -1
    for (const [i, { heading }] of items.entries()) {
      if (heading.getBoundingClientRect().top > line) break
      index = i
    }
    mark(index)
  }
  const schedule = () => { frame ||= requestAnimationFrame(follow) }
  preview.addEventListener('scroll', schedule, { passive: true })
  // The pressed heading stays marked (near the end it may stop below the read line) until the reader moves the page.
  for (const type of ['wheel', 'pointerdown', 'keydown']) preview.addEventListener(type, () => { pinned = false }, { passive: true })
  // Shown again after editing, or the pane resized: what is at the read line has changed without a scroll.
  if (globalThis.ResizeObserver) new ResizeObserver(schedule).observe(preview)

  // Drawn from what the preview shows, whenever that changes: the file rendered again, the document drawn again for a
  // theme, the page cleared for another file. Kept as it is while the preview has the same headings (code being coloured).
  const draw = () => {
    const outline = outlineOf(preview) ?? []
    if (outline.length === items.length && outline.every(({ heading, text }, i) => items[i].heading === heading && items[i].button.textContent === text)) return
    items = []
    at = -1
    pinned = false
    nav.hidden = outline.length === 0
    nav.replaceChildren(...outline.map(({ heading, depth, text }, index) => {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'outline-item'
      button.dataset.depth = String(depth)
      button.textContent = text
      button.title = text
      button.onclick = (event) => {
        pinned = true
        mark(index)
        heading.scrollIntoView({ behavior: 'smooth', block: 'start' })
        // A folded outline stays open while it holds focus (the keyboard's way through it); a pointer's press lets it fold.
        if (event.detail > 0) button.blur()
      }
      items.push({ heading, button })
      return button
    }))
    follow()
  }
  new MutationObserver(draw).observe(preview, { childList: true, subtree: true })
  draw()
}
