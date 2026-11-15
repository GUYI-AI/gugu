// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MessageBubble } from '../../../../apps/desktop/src/components/chat/MessageBubble'
import { createNode, createReactHarness, message, renderWithAppProviders } from '../../../support/testHarness'

// An agent's group message is read by people, often on a phone: every line break it sends is meant, as in a typed one
// (and as the session transcript already shows it). Lines that are not a Markdown list must not run into one line.
vi.mock('../../../../apps/desktop/src/hooks/useAgentHarnessIdentity', () => ({ useAgentHarnessIdentity: () => 'codex' }))
let harness: ReturnType<typeof createReactHarness>
beforeEach(() => {
  vi.stubGlobal('IntersectionObserver', class {
    constructor(private callback: (entries: { isIntersecting: boolean }[]) => void) {}
    observe() { this.callback([{ isIntersecting: true }]) }
    disconnect() {}
  })
  harness = createReactHarness()
})
afterEach(() => { harness.cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

async function show(content: string, isAgent: boolean) {
  await renderWithAppProviders(harness, createNode(MessageBubble, {
    msg: message({ is_mine: false, content }), isAgent,
    onReaction: vi.fn(), memberReadSeqs: {}, onQuote: vi.fn(), onForward: vi.fn(), onDelete: vi.fn(),
  }))
  const paragraphs = [...harness.container.querySelectorAll('p')].filter((p) => p.textContent?.includes('Rowan') || p.textContent?.includes('长段落'))
  return { breaks: paragraphs.reduce((n, p) => n + p.querySelectorAll('br').length, 0), lists: harness.container.querySelectorAll('ol').length, paragraphs }
}

describe('line breaks in an agent message stay line breaks', () => {
  it.each([
    ['a numbered line after the mention on the first line', '@Rowan 1. 整理书架\n2. 订会议室\n3. 回复供应商', 2],
    ['numbers with no space after the dot', '@Rowan 三件事：\n1.整理书架\n2.订会议室\n3.回复供应商', 3],
    ['numbers with 、', '@Rowan 三件事：\n1、整理书架\n2、订会议室\n3、回复供应商', 3],
    ['a list that starts at 2', '@Rowan 接着说：\n2. 订会议室\n3. 回复供应商', 2],
  ])('%s', async (_name, content, breaks) => {
    expect((await show(content, true)).breaks).toBe(breaks)
    // A person's message with the same text: unchanged.
    expect((await show(content, false)).breaks).toBe(breaks)
  })

  it('a long paragraph with no line break is not split', async () => {
    const shown = await show(`这是一个很长段落，${'内容会自然折行但没有换行符，'.repeat(12)}到此结束。`, true)
    expect(shown.paragraphs).toHaveLength(1)
    expect(shown.breaks).toBe(0)
  })

  it('a real Markdown list stays a list', async () => {
    const shown = await show('@Rowan 三件事：\n1. 整理书架\n2. 订会议室\n3. 回复供应商', true)
    expect(shown.lists).toBe(1)
    expect(shown.breaks).toBe(0)
  })
})
