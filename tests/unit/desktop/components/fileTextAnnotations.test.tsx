// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Markdown } from '@/components/markdown/Markdown'
import { FileTextContent } from '@/components/preview/FileTextContent'
import { fileTextRange, sourceLineRange } from '@/components/preview/file-text-range'

vi.mock('@/platform', () => ({ platform: { kind: 'web' } }))
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
    await act(async () => root.render(createElement(FileTextContent, { content, kind: 'text', fileName: 'a.ts', onAnnotate: vi.fn() })))
    const first = host.querySelector('[data-file-line="1"]')!
    const third = host.querySelector('[data-file-line="3"]')!
    const range = document.createRange()
    range.setStart(first.firstChild!, 1)
    range.setEnd(third.firstChild!, 0)
    expect(fileTextRange(host, range, content, 'text')).toEqual({ startLine: 1, endLine: 2, text: 'one\ntwo' })
    expect(sourceLineRange(content, 3, 1)).toEqual({ startLine: 1, endLine: 3, text: 'one\ntwo\nthree' })
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

it('saves the captured source after the comment input takes focus and lets another comment accumulate', async () => {
  const onAnnotate = vi.fn()
  await act(async () => root.render(createElement(FileTextContent, { content: 'first\nsecond\nthird', kind: 'text', fileName: 'a.ts', onAnnotate })))
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
    const add = document.querySelector<HTMLButtonElement>('.gg-file-annotation-popup button')!
    expect(add).not.toBeNull()
    await act(async () => add.click())
    const input = document.querySelector('input')!
    expect(input).not.toBeNull()
    if (line === 2) {
      const composingEnter = new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true })
      await act(async () => { input.dispatchEvent(composingEnter) })
      expect(composingEnter.defaultPrevented).toBe(true)
      expect(onAnnotate).not.toHaveBeenCalled()
    }
    await act(async () => {
      if (line === 2) {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Please update this line')
        input.dispatchEvent(new Event('input', { bubbles: true }))
      }
      input.focus()
      document.getSelection()?.removeAllRanges()
      document.dispatchEvent(new Event('selectionchange'))
    })
    await act(async () => document.querySelector<HTMLButtonElement>('.gg-file-annotation-form button[type="submit"]')!.click())
    expect(onAnnotate).toHaveBeenLastCalledWith({ startLine: line, endLine: line, text: line === 2 ? 'second' : 'third', annotation: line === 2 ? 'Please update this line' : '' })
  }
  expect(onAnnotate).toHaveBeenCalledTimes(2)
})

it('retains the selected quote and comment input after a failed save, then retries the same range', async () => {
  const onAnnotate = vi.fn().mockRejectedValueOnce(new Error('Queue refused')).mockResolvedValueOnce(undefined)
  await act(async () => root.render(createElement(FileTextContent, { content: 'one\ntwo', kind: 'text', fileName: 'a.ts', onAnnotate })))
  await act(async () => host.querySelector<HTMLButtonElement>('.gg-file-line-number')!.click())
  await act(async () => document.querySelector<HTMLButtonElement>('.gg-file-annotation-popup button')!.click())
  const submit = document.querySelector<HTMLButtonElement>('.gg-file-annotation-form button[type="submit"]')!
  await act(async () => submit.click())
  expect(document.querySelector('.gg-file-annotation-error[role="alert"]')).not.toBeNull()
  expect(document.querySelector('input')).not.toBeNull()
  await act(async () => submit.click())
  expect(onAnnotate.mock.calls).toEqual([[{ startLine: 1, endLine: 1, text: 'one', annotation: '' }], [{ startLine: 1, endLine: 1, text: 'one', annotation: '' }]])
  expect(document.querySelector('.gg-file-annotation-form')).toBeNull()
})

it('allows a code gutter comment on the empty final source line', async () => {
  const onAnnotate = vi.fn()
  await act(async () => root.render(createElement(FileTextContent, { content: 'one\n', kind: 'text', fileName: 'a.ts', onAnnotate })))
  await act(async () => host.querySelectorAll<HTMLButtonElement>('.gg-file-line-number')[1].click())
  await act(async () => {
    document.dispatchEvent(new Event('selectionchange'))
    await new Promise(resolve => requestAnimationFrame(resolve))
  })
  await act(async () => document.querySelector<HTMLButtonElement>('.gg-file-annotation-popup button')!.click())
  await act(async () => document.querySelector<HTMLButtonElement>('.gg-file-annotation-form button[type="submit"]')!.click())
  expect(onAnnotate).toHaveBeenCalledWith({ startLine: 2, endLine: 2, text: '', annotation: '' })
})
