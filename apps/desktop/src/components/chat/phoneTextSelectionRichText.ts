import { insertNativeListMarkers, type NativeRichColor, type NativeRichParagraph, type NativeRichRun, type NativeRichText } from '@/platform/nativeRichText'
import type { PhoneTextSelectionSource } from './phoneTextSelectionSource'
import { createPhoneTextSelectionColorReader } from './phoneTextSelectionColor'

const EXCLUDED = 'button,svg,script,style,img,video,audio,iframe,object,embed,link,[aria-hidden="true"]'
const PARAGRAPH = 'p,h1,h2,h3,h4,h5,h6,pre,li'
const px = (value: string) => Number.parseFloat(value) || 0


function paragraphOwner(element: HTMLElement, root: HTMLElement): HTMLElement {
  for (let parent: HTMLElement | null = element; parent && parent !== root; parent = parent.parentElement) {
    if (parent.matches(PARAGRAPH) || /^(block|flex|grid|table|list-item)$/.test(getComputedStyle(parent).display)) return parent
  }
  return root
}

function listMarker(item: HTMLLIElement): string {
  const parent = item.parentElement
  if (parent?.tagName !== 'OL') return '•'
  const list = parent as HTMLOListElement
  const siblings = [...parent.children].filter(element => element.tagName === 'LI')
  const first = list.hasAttribute('start') ? list.start : list.reversed ? siblings.length : 1
  const index = siblings.indexOf(item)
  return `${item.hasAttribute('value') ? item.value : first + index * (list.reversed ? -1 : 1)}.`
}

/** Keep the exact captured text; styling ranges never reconstruct or omit message content. */
export function phoneTextSelectionRichText(source: PhoneTextSelectionSource): NativeRichText {
  const root = source.element
  const originalStyle = root.getAttribute('style')
  const document = root.ownerDocument
  const color = createPhoneTextSelectionColorReader(document)
  const clone = root.cloneNode(true) as HTMLElement
  const originals = [root, ...root.querySelectorAll<HTMLElement>('*')]
  const copies = [clone, ...clone.querySelectorAll<HTMLElement>('*')]
  const paired = new Map(originals.map((element, index) => [element, copies[index]]))
  const rootStyle = getComputedStyle(root)
  Object.assign(clone.style, { fontFamily: rootStyle.fontFamily, fontSize: rootStyle.fontSize, fontWeight: rootStyle.fontWeight,
    fontStyle: rootStyle.fontStyle, letterSpacing: rootStyle.letterSpacing, lineHeight: rootStyle.lineHeight, width: `${root.getBoundingClientRect().width}px` })
  for (const element of copies) {
    element.removeAttribute('id')
    element.removeAttribute('data-testid')
    element.style.setProperty('content-visibility', 'visible', 'important')
  }
  const host = document.createElement('div')
  host.inert = true
  host.setAttribute('aria-hidden', 'true')
  Object.assign(host.style, { position: 'fixed', left: '-100000px', top: '0', opacity: '0', pointerEvents: 'none', width: `${root.getBoundingClientRect().width}px` })
  host.append(clone)
  document.body.append(host)
  try {
    const runs: NativeRichRun[] = []
    const paragraphs = new Map<HTMLElement, { start: number; end: number }>()
    const coverage = new Uint8Array(source.text.length)
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    let cursor = 0
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const element = node.parentElement
      if (!element || element.closest(EXCLUDED)) continue
      let hidden = false
      for (let parent: HTMLElement | null = element; parent && root.contains(parent); parent = parent.parentElement) {
        const style = getComputedStyle(parent)
        if (style.display === 'none' || style.visibility === 'hidden') { hidden = true; break }
      }
      if (hidden) continue
      const style = getComputedStyle(element)
      const raw = node.textContent ?? ''
      const preserve = /pre|break-spaces/.test(style.whiteSpace)
      let value = preserve ? raw : raw.replace(/\s+/g, ' ').trim()
      if (!value) continue
      if (style.textTransform === 'uppercase') value = value.toLocaleUpperCase()
      if (style.textTransform === 'lowercase') value = value.toLocaleLowerCase()
      let start = source.text.indexOf(value, cursor)
      if (start < 0) throw new Error('Native rich text does not match the visible message')
      let end = start + value.length
      if (!preserve && /^\s/.test(raw) && /^[ \t\u00a0]+$/.test(source.text.slice(cursor, start))) start = cursor
      if (!preserve && /\s$/.test(raw) && source.text[end] === ' ') end++
      cursor = end
      coverage.fill(1, start, end)
      let background: NativeRichColor | undefined
      // Block backgrounds are drawn once by the native layout; only inline code needs a run background.
      if (element.closest('code') && !element.closest('pre')) for (let parent: HTMLElement | null = element; parent && parent !== root; parent = parent.parentElement) {
        const next = color(getComputedStyle(parent).backgroundColor)
        if (next.alpha > 0) { background = next; break }
      }
      const link = element.closest('a')
      runs.push({ start, end, fontSize: px(style.fontSize), weight: style.fontWeight === 'bold' ? 700 : px(style.fontWeight) || 400,
        italic: /italic|oblique/.test(style.fontStyle), underline: style.textDecorationLine.includes('underline') || !!link && getComputedStyle(link).textDecorationLine.includes('underline'),
        monospace: /mono|menlo|consolas|courier/i.test(style.fontFamily), color: color(style.color), ...(background ? { background } : {}),
      })
      const owner = paragraphOwner(element, root)
      const previous = paragraphs.get(owner)
      paragraphs.set(owner, { start: previous?.start ?? start, end })
    }
    for (let index = 0; index < source.text.length; index++) {
      if (!coverage[index] && !/\s/.test(source.text[index])) throw new Error('Native rich text omitted visible content')
    }
    const rootBounds = clone.getBoundingClientRect()
    const marked = new Set<Element>()
    const entries = [...paragraphs].sort((a, b) => a[1].start - b[1].start)
    const result: NativeRichParagraph[] = entries.map(([element, range], index) => {
      const style = getComputedStyle(element)
      const bounds = paired.get(element)!.getBoundingClientRect()
      const next = entries[index + 1]
      const gap = next ? Math.max(0, paired.get(next[0])!.getBoundingClientRect().top - bounds.bottom) : 0
      const separator = next ? source.text.slice(range.end, next[1].start) : ''
      const firstBreak = source.text[range.end - 1] === '\n' ? 0 : 1
      const blanks = /^\n+$/.test(separator) ? Math.max(0, separator.length - firstBreak) : 0
      const indent = Math.max(0, bounds.left - rootBounds.left)
      const list = element.closest('li') as HTMLLIElement | null
      const marker = list && !marked.has(list) ? listMarker(list) : undefined
      if (list) marked.add(list)
      const fontSize = px(style.fontSize)
      const markerStyle = marker && list ? getComputedStyle(list, '::marker') : undefined
      let lineHeight = px(style.lineHeight) || fontSize * 1.2
      if (element !== root && !element.matches(PARAGRAPH) && !source.text.slice(range.start, range.end).includes('\n')) lineHeight = Math.max(lineHeight, bounds.height)
      return { ...range, lineHeight, before: 0, after: Math.max(0, gap - blanks * 0.5), indent,
        firstLineIndent: marker ? Math.max(0, indent - fontSize * 1.25) : indent,
        ...(marker && markerStyle ? { marker, markerStyle: {
          fontSize: px(markerStyle.fontSize) || fontSize,
          weight: px(markerStyle.fontWeight) || 400,
          italic: /italic|oblique/.test(markerStyle.fontStyle),
          monospace: /mono|menlo|consolas|courier/i.test(markerStyle.fontFamily),
          color: color(markerStyle.color),
        } } : {}),
      }
    })
    // Preserve copied breaks; paragraph metrics handle blank spacing without introducing another font size.
    for (let index = 0; index < entries.length - 1; index++) {
      const previousEnd = entries[index][1].end
      const start = previousEnd + (source.text[previousEnd - 1] === '\n' ? 0 : 1)
      const end = entries[index + 1][1].start
      if (start < end && /^\n+$/.test(source.text.slice(start, end))) {
        result.push({ start, end, lineHeight: 0.5, before: 0, after: 0, indent: 0, firstLineIndent: 0 })
      }
    }
    const codeContainers = new Map<HTMLElement, { start: number; end: number; first: HTMLElement; last: HTMLElement }>()
    for (const [element, range] of entries) {
      const pre = element.closest<HTMLElement>('pre')
      const container = element.closest<HTMLElement>('[data-streamdown="code-block"]') ?? pre
      if (!container) continue
      const old = codeContainers.get(container)
      codeContainers.set(container, { start: old?.start ?? range.start, end: range.end, first: old?.first ?? element, last: element })
    }
    const blocks = [...codeContainers].map(([element, range]) => {
      const bounds = paired.get(element)!.getBoundingClientRect()
      const first = paired.get(range.first)!.getBoundingClientRect()
      const last = paired.get(range.last)!.getBoundingClientRect()
      let background = color(getComputedStyle(element).backgroundColor)
      for (let parent = element.parentElement; background.alpha === 0 && parent && parent !== root; parent = parent.parentElement) background = color(getComputedStyle(parent).backgroundColor)
      return { start: range.start, end: range.end, background, insetLeft: Math.max(0, bounds.left - rootBounds.left), insetRight: Math.max(0, rootBounds.right - bounds.right),
        paddingTop: Math.max(0, first.top - bounds.top), paddingBottom: Math.max(0, bounds.bottom - last.bottom), radius: px(getComputedStyle(element).borderTopLeftRadius),
        trailingSpacing: result.find(paragraph => paragraph.end === range.end)?.after ?? 0,
      }
    })
    return insertNativeListMarkers({ text: source.text, start: source.start, end: source.end, runs, paragraphs: result, blocks })
  } finally {
    host.remove()
    if (originalStyle === null) root.removeAttribute('style')
    else root.setAttribute('style', originalStyle)
  }
}
