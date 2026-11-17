// @vitest-environment jsdom
// A search result opened: the words searched for are marked inside that message's flash (::highlight(gugu-search-hit),
// faded by the msg-src-flash animation) and gone with it. Only the flash of the asked message takes them, once.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createNode, createReactHarness } from '../../../support/testHarness'

const { MessageRow } = await import('../../../../apps/desktop/src/components/chat/MessageRow')
const { askFlashWords, takeFlashWords } = await import('../../../../apps/desktop/src/lib/sourceMessageReveal')

let harness: ReturnType<typeof createReactHarness>
const highlights = new Map<string, { range: Range }>()
const painted = () => highlights.get('gugu-search-hit')?.range.toString() ?? null
const row = (messageId: string, flash: boolean) => createNode(MessageRow, { messageId, flash }, createNode('span', null, '周一的会议改到下午三点'))

beforeEach(() => {
  vi.stubGlobal('CSS', { highlights })
  vi.stubGlobal('Highlight', class { constructor(public range: Range) {} })
  harness = createReactHarness()
})
afterEach(() => { harness.cleanup(); highlights.clear(); takeFlashWords('m1'); vi.unstubAllGlobals() })

describe('search words inside a message flash', () => {
  it('marks the words while the asked message flashes, then erases them with the flash', async () => {
    askFlashWords('m1', '会议')
    await harness.render(row('m1', false))
    expect(painted()).toBeNull()
    await harness.render(row('m1', true))
    expect(harness.container.querySelector('.msg-src-flash')).not.toBeNull()
    expect(painted()).toBe('会议')
    await harness.render(row('m1', false))
    expect(painted()).toBeNull()
    await harness.render(row('m1', true))
    expect(painted(), 'the words were taken by the first flash').toBeNull()
  })

  it('another message flashing does not take them', async () => {
    askFlashWords('m1', '会议')
    await harness.render(row('m2', true))
    expect(painted()).toBeNull()
    expect(takeFlashWords('m1')).toBe('会议')
  })
})
