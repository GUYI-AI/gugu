// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Markdown } from '@/components/markdown/Markdown'
import { selectionCite } from '@/components/preview/quote-preview-file'
import { drawnItems, parseSelectionAction, selectionConversationOf, selectionMenu } from '@/session/shared/extensions/file-selection'
import { i18n } from '@/i18n'
import '@/i18n/registerMessagingCatalog'

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

const place = { rect: { x: 0, y: 0, width: 10, height: 10 }, viewport: { width: 100, height: 100 } }

describe('whose conversation a selection is', () => {
  it('a session page\'s, else the chat the page is drawn in, else none', () => {
    expect(selectionConversationOf({ session: 's-1', chat: 'g-1' })).toEqual({ kind: 'session', sessionId: 's-1' })
    expect(selectionConversationOf({ session: null, chat: 'g-1' })).toEqual({ kind: 'chat', chatId: 'g-1' })
    expect(selectionConversationOf({})).toBeNull()
  })
})

describe('the one menu\'s table', () => {
  const chat = { kind: 'chat' as const, chatId: 'g-1' }
  const ids = (items: { id: string }[]) => items.map(item => item.id)
  it('Copy always (drawn with words); Cite with a conversation and a file named; Send also needs a surface that can send', () => {
    expect(selectionMenu(chat, true, true, 'zh-CN')).toEqual([{ id: 'copy', label: '复制' }, { id: 'cite', label: '引用' }, { id: 'send', label: '发送' }])
    expect(ids(selectionMenu(chat, true, false, 'en-US'))).toEqual(['copy', 'cite'])
    expect(ids(selectionMenu(null, true, true, 'en-US'))).toEqual(['copy'])
    expect(ids(selectionMenu(chat, false, true, 'en-US'))).toEqual(['copy'])
    // A shape or a cell picked alone: nothing to copy, still a place to cite.
    expect(ids(drawnItems(selectionMenu(chat, true, true, 'en-US'), false))).toEqual(['cite', 'send'])
  })
})

describe('what a press hands the host', () => {
  it('the action, a pick in a file at its places and its box; anything else is refused as invalid', () => {
    const file = { workspace: 'folder:d-1/w-1', id: 'AGENTS.md' }
    expect(parseSelectionAction({ action: 'cite', file, places: [{ at: { lines: '3-4' } }], text: 'words', ...place }))
      .toEqual({ action: 'cite', file, pick: { places: [{ at: { lines: '3-4' } }], text: 'words' }, ...place })
    // Another App's places: its own keys, named in the reader's words; no text.
    const sheet = { places: [{ at: { sheet: 'Sheet1', cell: 'B2' }, label: 'Sheet1!B2' }] }
    expect(parseSelectionAction({ action: 'send', file, ...sheet, ...place })).toEqual({ action: 'send', file, pick: sheet, ...place })
    for (const bad of [{ action: 'copy' }, { places: [] }, { places: [{ at: {} }] }, { places: [{ at: { lines: 3 } }] }, { places: [{ at: { lines: '1' } }], text: '' },
      { places: [{ at: { lines: '1' } }], send: true }, { places: Array.from({ length: 9 }, () => ({ at: { lines: '1' } })) }]) {
      expect(() => parseSelectionAction({ action: 'cite', file, places: [{ at: { lines: '1' } }], ...place, ...bad })).toThrow(expect.objectContaining({ code: 'invalid' }))
    }
  })
})

describe('a cite', () => {
  const session = { kind: 'session' as const, sessionId: 's-1' }, chat = { kind: 'chat' as const, chatId: 'g-1' }
  it('names a computer\'s file by its path, a pill per place in a session, and no quote of its words beside it', async () => {
    await i18n.changeLanguage('en-US')
    const cite = selectionCite(session, { name: 'proof.md', target: '/repo/docs/proof.md' }, { text: '设 a 为偶数', places: [{ at: { lines: '3-4' } }] })
    expect(cite.refs).toEqual([{ label: 'proof.md (Lines 3–4)', link: '/repo/docs/proof.md' }])
    expect(cite.draft).toBe('@[proof.md (Lines 3–4)](/repo/docs/proof.md)')
    await act(async () => root.render(createElement(Markdown, { content: cite.draft, trust: 'chat' })))
    expect(host.querySelector('blockquote')).toBeNull()
    expect(host.textContent).toContain('proof.md (Lines 3–4)')
  })

  it('in a chat, a computer\'s file is named in words with its path written out: a chat has no pill that opens it', async () => {
    await i18n.changeLanguage('en-US')
    const cite = selectionCite(chat, { name: 'AGENTS.md', target: '/work/AGENTS.md' }, { text: 'run the gates', places: [{ at: { lines: '5' } }] })
    expect(cite).toEqual({ quote: '> run the gates\n\nAGENTS.md (Line 5): /work/AGENTS.md', refs: [], draft: '> run the gates\n\nAGENTS.md (Line 5): /work/AGENTS.md' })
  })

  it('points a chat file\'s pills at their places, named as the App named them', () => {
    const cite = selectionCite(chat, { name: 'plan.xlsx', target: 'gugu-file://11111111-1111-4111-8111-111111111111?v=3' },
      { places: [{ at: { sheet: 'Sheet1', cell: 'B2' }, label: 'Sheet1!B2' }, { at: { lines: '7' } }] })
    expect(cite.quote).toBe('')
    expect(cite.refs).toEqual([
      { label: 'plan.xlsx (Sheet1!B2)', link: 'gugu-file://11111111-1111-4111-8111-111111111111?v=3#sheet=Sheet1&cell=B2' },
      { label: 'plan.xlsx (Line 7)', link: 'gugu-file://11111111-1111-4111-8111-111111111111?v=3#lines=7' },
    ])
  })

  it('of a file whole is its pill alone', () => {
    expect(selectionCite(chat, { name: 'a.md', target: 'gugu-file://11111111-1111-4111-8111-111111111111' }, null)).toEqual({ quote: '', refs: [{ label: 'a.md', link: 'gugu-file://11111111-1111-4111-8111-111111111111' }], draft: '@[a.md](gugu-file://11111111-1111-4111-8111-111111111111)' })
  })
})
