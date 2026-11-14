// @vitest-environment jsdom
// B3 (fe-continuity): the list sorts by newest activity. While the pointer is over it, a row does not move out from under the
// pointer when another conversation gets a message; the order catches up when the pointer leaves, or rests for a while.
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ChatListPanel } from '../../../../apps/desktop/src/components/ChatListPanel'
import { chat, createNode, createReactHarness, renderWithAppProviders } from '../../../support/testHarness'

vi.mock('../../../../apps/desktop/src/platform', () => import('../../../support/capacitorPlatformTestDouble'))

let harness: ReturnType<typeof createReactHarness>
beforeEach(() => { harness = createReactHarness() })
afterEach(() => { harness.cleanup(); vi.useRealTimers() })

const chats = ['a', 'b', 'c'].map((id, index) => chat({ id, kind: 'group', name: `Group ${id}`, last_message_at: `2099-01-0${3 - index}T00:00:00Z` }))
const node = createNode(ChatListPanel, {})
const identitiesById = {}
const render = (rows: typeof chats) => renderWithAppProviders(harness, node, { chat: { chats: rows, identitiesById }, contacts: {} })
const order = () => [...harness.container.querySelectorAll<HTMLElement>('[data-chat-row]')].map(row => row.dataset.chatRow)
const list = () => harness.container.querySelector<HTMLElement>('[role="listbox"]')!
// React derives onPointerLeave from `pointerout` towards an element outside.
const pointer = (type: 'pointermove' | 'pointerleave') => act(async () => {
  const event = new MouseEvent(type === 'pointermove' ? 'pointermove' : 'pointerout', { bubbles: true, relatedTarget: type === 'pointerleave' ? document.body : null })
  Object.defineProperty(event, 'pointerType', { value: 'mouse' })
  list().dispatchEvent(event)
})
const cMessaged = () => [...chats.slice(0, 2), { ...chats[2]!, last_message_at: '2099-01-09T00:00:00Z', last_message_preview: 'new in c' }]

it('holds the order while the pointer is over the list and re-sorts when it leaves', async () => {
  await render(chats)
  expect(order()).toEqual(['a', 'b', 'c'])
  await pointer('pointermove')
  await render(cMessaged())
  expect(order(), 'the row under the pointer stays put').toEqual(['a', 'b', 'c'])
  expect(harness.container.querySelector('[data-chat-row="c"]')?.textContent, 'the row itself still updates').toContain('new in c')
  await pointer('pointerleave')
  expect(order()).toEqual(['c', 'a', 'b'])
})

it('lets go once the pointer has rested a few seconds', async () => {
  vi.useFakeTimers()
  await render(chats)
  await pointer('pointermove')
  await render(cMessaged())
  expect(order()).toEqual(['a', 'b', 'c'])
  await act(async () => { vi.advanceTimersByTime(3000) })
  expect(order()).toEqual(['c', 'a', 'b'])
})

it('re-sorts at once when the pointer is elsewhere', async () => {
  await render(chats)
  await render(cMessaged())
  expect(order()).toEqual(['c', 'a', 'b'])
})
