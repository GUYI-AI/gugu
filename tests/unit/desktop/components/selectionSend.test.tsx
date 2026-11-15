// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fileCiteDraft } from '@gugu/session-shared/markdown'
import { Markdown } from '@/components/markdown/Markdown'
import { selectionSendBody, selectionSendOf } from '@/session/shared/extensions/selection-send'

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
  host.remove()
})

const text = '> 设 a 为偶数 则 a² 为偶数'
const refs = [{ file: { workspace: 'session:task-1', id: 'docs/proof.md' }, label: 'Lines 3–4' }]
const place = { rect: { x: 0, y: 0, width: 10, height: 10 }, viewport: { width: 100, height: 100 } }

describe('what Send sends', () => {
  it('is the cite exactly as fileCiteDraft writes it, a blank line, then the person\'s words', () => {
    const { draft } = selectionSendOf({ text, refs, ...place }, 'session:task-1')
    expect(draft).toBe(fileCiteDraft(text, refs))
    expect(selectionSendBody(draft, '  怎么证明？ @Claude  ')).toBe(`${fileCiteDraft(text, refs)}\n\n怎么证明？ @Claude`)
    expect(selectionSendBody(draft, ' \n ')).toBe(fileCiteDraft(text, refs))
  })

  it('reads in the bubble as a quote, a pill, then the words: no JSON, no heading', async () => {
    const body = selectionSendBody(selectionSendOf({ text, refs, ...place }, 'session:task-1').draft, '怎么证明？')
    await act(async () => root.render(createElement(Markdown, { content: body, trust: 'chat' })))
    const blocks = [...host.querySelectorAll('blockquote, p')].filter(block => !block.parentElement?.closest('blockquote'))
    expect(blocks.map(block => block.tagName)).toEqual(['BLOCKQUOTE', 'P', 'P'])
    expect(blocks[0]!.textContent?.trim()).toBe('设 a 为偶数 则 a² 为偶数')
    expect(blocks[1]!.querySelector('a, [data-mention], .gg-md-mention')?.textContent).toContain('proof.md · Lines 3–4')
    expect(blocks[2]!.textContent).toBe('怎么证明？')
    expect(host.textContent).not.toMatch(/[{}]|# /)
  })
})
