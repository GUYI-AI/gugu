// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Markdown } from '@/components/markdown/Markdown'
import { FileTextContent } from '@/components/preview/FileTextContent'
import { fileTextRange, sourceLineRange } from '@/components/preview/file-text-range'
import { selectionPosition } from '@/components/preview/quote-preview-file'
import { i18n } from '@/i18n'
import '@/i18n/registerMessagingCatalog'
import { readFileSync } from 'node:fs'

vi.mock('@/platform', () => ({ platform: { kind: 'web' } }))
const comment = vi.hoisted(() => vi.fn())
vi.mock('@renderer/features/sessions/annotations/selection-line', () => ({ openCommentLine: comment }))
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement, root: Root
beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount())
  document.getSelection()?.removeAllRanges()
  host.remove()
})

const file = { name: 'notes.txt', target: '/home/me/notes.txt' }
/** A chat's text preview: Copy · Comment where its composer sends comments (`sends`), Copy alone where it does not. */
const selectable = (sends = true) => ({ conversation: { kind: 'chat' as const, chatId: 'group-1' }, file, sends })

async function markdown(content: string) {
  await act(async () => root.render(createElement(Markdown, { content, trust: 'chat', hardBreaks: true, sourceLines: true })))
}

describe('file source ranges', () => {
  it('identifies the second occurrence of a repeated quote by its parsed source location', async () => {
    const content = '# Heading\n\nRepeated **words**\n\nRepeated **words**'
    await markdown(content)
    const words = [...host.querySelectorAll('span[data-file-source-start]')].filter(span => span.textContent === 'words' && span.firstChild?.nodeType === Node.TEXT_NODE)
    expect(words).toHaveLength(2)
    const range = document.createRange()
    range.selectNodeContents(words[1])
    expect(fileTextRange(host, range, content, 'markdown')).toEqual({ startLine: 5, endLine: 5, text: 'words' })
  })

  it('preserves the original line after hard-break splitting and inline formatting', async () => {
    const content = '# Heading\n\nFirst line\nSecond **bold** line\nThird line'
    await markdown(content)
    const spans = [...host.querySelectorAll<HTMLSpanElement>('span[data-file-source-start]')]
    const second = spans.find(span => span.textContent === 'Second ')!
    const third = spans.find(span => span.textContent === 'Third line')!
    expect(second).toBeDefined()
    expect(third).toBeDefined()
    const range = document.createRange()
    range.setStart(second.firstChild!, 0)
    range.setEnd(third.firstChild!, 5)
    expect(fileTextRange(host, range, content, 'markdown')).toMatchObject({ startLine: 4, endLine: 5 })
    expect(fileTextRange(host, range, content, 'markdown')?.text).toContain('Second bold line')
  })

  it('keeps a decoded newline entity on its physical source line', async () => {
    const content = 'first&#10;still first\r\nsecond'
    await markdown(content)
    const spans = [...host.querySelectorAll('span[data-file-source-start]')]
    const first = spans.find(span => span.textContent === 'still first')!
    expect(first).toBeDefined()
    const second = spans.find(span => span.textContent === 'second')!
    const range = document.createRange()
    range.selectNodeContents(first)
    expect(fileTextRange(host, range, content, 'markdown')).toEqual({ startLine: 1, endLine: 1, text: 'still first' })
    range.selectNodeContents(second)
    expect(fileTextRange(host, range, content, 'markdown')).toEqual({ startLine: 2, endLine: 2, text: 'second' })
  })

  it('excludes the untouched next line at an end boundary and keeps code text without line numbers', async () => {
    const content = 'one\r\ntwo\r\nthree'
    await act(async () => root.render(createElement(FileTextContent, { content, kind: 'text', selectable: selectable() })))
    const first = host.querySelector('[data-file-line="1"]')!
    const third = host.querySelector('[data-file-line="3"]')!
    const range = document.createRange()
    range.setStart(first.firstChild!, 1)
    range.setEnd(third.firstChild!, 0)
    expect(fileTextRange(host, range, content, 'text')).toEqual({ startLine: 1, endLine: 2, text: 'one\ntwo' })
    expect(sourceLineRange(content, 3, 1)).toEqual({ startLine: 1, endLine: 3, text: 'one\ntwo\nthree' })
  })

  it('says a formula once, as its TeX, not its TeX and its glyphs both', async () => {
    const content = '上确界 $\\sup a_n$ 就是极限。\n\n$$L-\\varepsilon$$'
    await markdown(content)
    expect(host.querySelector('.katex')).not.toBeNull()
    const range = document.createRange()
    range.selectNodeContents(host.querySelector('p')!)
    expect(fileTextRange(host, range, content, 'markdown')).toEqual({ startLine: 1, endLine: 1, text: '上确界 $\\sup a_n$ 就是极限。' })
    range.selectNodeContents(host)
    expect(fileTextRange(host, range, content, 'markdown')?.text).toBe('上确界 $\\sup a_n$ 就是极限。\n$$L-\\varepsilon$$')
  })

  it('rejects a selection extending into another file', () => {
    host.innerHTML = '<span data-file-source-start="1">one</span>'
    const elsewhere = document.createTextNode('other file')
    document.body.append(elsewhere)
    const range = document.createRange()
    range.setStart(host.firstChild!.firstChild!, 0)
    range.setEnd(elsewhere, 3)
    expect(fileTextRange(host, range, 'one', 'markdown')).toBeNull()
    elsewhere.remove()
  })

  it('maps a selected line inside a rendered Markdown code fence', async () => {
    const content = '# Heading\n\n```ts\nconst one = 1;\nconst two = 2;\n```'
    await markdown(content)
    const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT)
    let chosen: Text | null = null
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.textContent?.includes('const two')) { chosen = node as Text; break }
    }
    expect(chosen).not.toBeNull()
    const range = document.createRange()
    const start = chosen!.textContent!.indexOf('const two')
    range.setStart(chosen!, start)
    range.setEnd(chosen!, start + 9)
    expect(fileTextRange(host, range, content, 'markdown')).toEqual({ startLine: 5, endLine: 5, text: 'const two' })
  })
})

it('comments on each selected range on its own, as many times as asked; no Cite (a selection is commented on)', async () => {
  comment.mockClear()
  await act(async () => root.render(createElement(FileTextContent, { content: 'first\nsecond\nthird', kind: 'text', selectable: selectable() })))
  for (const line of [2, 3]) {
    const span = host.querySelector(`[data-file-line="${line}"]`)!
    const range = document.createRange()
    range.selectNodeContents(span)
    await act(async () => {
      document.getSelection()?.removeAllRanges()
      document.getSelection()?.addRange(range)
      document.dispatchEvent(new Event('selectionchange'))
    })
    await act(async () => { await new Promise(resolve => requestAnimationFrame(resolve)) })
    const buttons = document.querySelectorAll<HTMLButtonElement>('.gugu-selection-menu button')
    expect([...buttons].map(button => button.dataset.fileSelectionAction)).toEqual(['copy', 'send'])
    await act(async () => buttons[1].click())
    expect(comment).toHaveBeenLastCalledWith(selectable().conversation, expect.anything(), expect.any(HTMLElement),
      { kind: 'file', file, places: [{ at: { lines: `${line}` } }], text: line === 2 ? 'second' : 'third' }, null)
    expect(document.querySelector('.gugu-selection-menu')).toBeNull()
  }
  expect(comment).toHaveBeenCalledTimes(2)
})

it('offers Copy alone where the composer sends no comments', async () => {
  await act(async () => root.render(createElement(FileTextContent, { content: 'first\nsecond', kind: 'text', selectable: selectable(false) })))
  const range = document.createRange()
  range.selectNodeContents(host.querySelector('[data-file-line="2"]')!)
  await act(async () => {
    document.getSelection()?.addRange(range)
    document.dispatchEvent(new Event('selectionchange'))
    await new Promise(resolve => requestAnimationFrame(resolve))
  })
  expect([...document.querySelectorAll<HTMLButtonElement>('.gugu-selection-menu button')].map(button => button.dataset.fileSelectionAction)).toEqual(['copy'])
})

it('comments on a code gutter range, including the empty final source line', async () => {
  comment.mockClear()
  await act(async () => root.render(createElement(FileTextContent, { content: 'one\n', kind: 'text', selectable: selectable() })))
  const gutter = host.querySelectorAll<HTMLButtonElement>('.gg-file-line-number')
  await act(async () => gutter[0].click())
  await act(async () => gutter[1].dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true })))
  await act(async () => {
    document.dispatchEvent(new Event('selectionchange'))
    await new Promise(resolve => requestAnimationFrame(resolve))
  })
  await act(async () => document.querySelector<HTMLButtonElement>('.gugu-selection-menu [data-file-selection-action="send"]')!.click())
  expect(comment).toHaveBeenCalledWith(selectable().conversation, expect.anything(), expect.any(HTMLElement), { kind: 'file', file, places: [{ at: { lines: '1-2' } }], text: 'one\n' }, null)
})

it('says a place as the Files App does, word for word', async () => {
  const app = readFileSync('apps/desktop/preinstalled-apps/workspace/app.js', 'utf8')
  // The App's own strings, in the order its table has them: zh first, then en.
  const [zh, en] = [...app.matchAll(/^ {4}line: '(.+)',\n {4}lines: '(.+)',$/gm)].map(([, line, lines]) => ({ line: line!, lines: lines! }))
  for (const [language, strings] of [['zh-CN', zh!], ['en-US', en!]] as const) {
    await i18n.changeLanguage(language)
    expect(selectionPosition({ text: '', at: { lines: '10' } })).toBe(strings.line.replace('{first}', '10'))
    expect(selectionPosition({ text: '', at: { lines: '10-11' } })).toBe(strings.lines.replace('{first}', '10').replace('{last}', '11'))
  }
})
