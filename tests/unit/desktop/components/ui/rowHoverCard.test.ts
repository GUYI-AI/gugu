// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ROW_HOVER_CARD_OPEN_DELAY_MS, RowHoverCardController } from '../../../../../apps/desktop/src/components/ui/rowHoverCardController'

/**
 * The one hover card every list uses (a group's agent rows, the rail's group / person rows, the running-agent pills).
 * Its timing is the product's: time is an input here (fake timers), never a wall-clock wait.
 */

let card: RowHoverCardController
let rowA: HTMLElement
let rowB: HTMLElement
let popup: HTMLElement
let elsewhere: HTMLElement

beforeEach(() => {
  vi.useFakeTimers()
  card = new RowHoverCardController('list')
  const el = (attrs: Record<string, string>) => {
    const node = document.createElement('div')
    for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value)
    document.body.append(node)
    return node
  }
  rowA = el({ 'data-row-hover-trigger': 'list' })
  rowB = el({ 'data-row-hover-trigger': 'list' })
  popup = el({ 'data-row-hover-card': 'list' })
  elsewhere = el({ 'data-row-hover-trigger': 'another-list' })
})

afterEach(() => {
  vi.useRealTimers()
  document.body.replaceChildren()
})

it('opens only after the pointer rests the full delay', () => {
  card.enter('a', 'mouse')
  vi.advanceTimersByTime(ROW_HOVER_CARD_OPEN_DELAY_MS - 1)
  expect(card.activeKey).toBeNull()
  vi.advanceTimersByTime(1)
  expect(card.activeKey).toBe('a')
  expect(ROW_HOVER_CARD_OPEN_DELAY_MS).toBe(400)
})

it('sweeping past a row before the delay opens nothing', () => {
  card.enter('a', 'mouse')
  vi.advanceTimersByTime(200)
  card.leave('a', rowB)
  card.enter('b', 'mouse')
  vi.advanceTimersByTime(200)
  expect(card.activeKey, 'b waits its own full delay').toBeNull()
  vi.advanceTimersByTime(ROW_HOVER_CARD_OPEN_DELAY_MS)
  expect(card.activeKey).toBe('b')
})

it('with a card open, the next row of the list takes it at once', () => {
  card.open('a')
  card.leave('a', rowB)
  expect(card.activeKey, 'stepping onto another row of the list keeps the card until that row takes it').toBe('a')
  card.enter('b', 'mouse')
  expect(card.activeKey).toBe('b')
  expect(vi.getTimerCount()).toBe(0)
})

it('leaving closes at once, unless the pointer goes into the card or onto a row of the same list', () => {
  card.open('a')
  card.leave('a', popup)
  expect(card.activeKey, 'into the card').toBe('a')
  card.leave('a', rowA)
  expect(card.activeKey, 'back from the card to the row').toBe('a')
  card.leave('a', elsewhere)
  expect(card.activeKey, "another list's row is not this list").toBeNull()
  expect(vi.getTimerCount(), 'no grace timer').toBe(0)

  card.open('a')
  card.leave('a', null)
  expect(card.activeKey, 'out of the window').toBeNull()
})

it('a press is not a hover: it closes the card and the row stays closed until the pointer has left it', () => {
  card.enter('a', 'mouse')
  card.press('a', 'mouse')
  vi.advanceTimersByTime(ROW_HOVER_CARD_OPEN_DELAY_MS * 3)
  expect(card.activeKey, 'pressed during the wait').toBeNull()
  card.enter('a', 'mouse')
  vi.advanceTimersByTime(ROW_HOVER_CARD_OPEN_DELAY_MS)
  expect(card.activeKey, 'still on the pressed row').toBeNull()

  card.leave('a', null)
  card.enter('a', 'mouse')
  vi.advanceTimersByTime(ROW_HOVER_CARD_OPEN_DELAY_MS)
  expect(card.activeKey, 'left and came back: a fresh hover').toBe('a')

  card.press('a', 'mouse')
  expect(card.activeKey, 'pressed while open').toBeNull()
})

it('touch never opens it', () => {
  card.enter('a', 'touch')
  vi.advanceTimersByTime(ROW_HOVER_CARD_OPEN_DELAY_MS)
  expect(card.activeKey).toBeNull()
})

it('closing a row only closes its own card, and cancels only its own pending open', () => {
  card.open('b')
  card.close('a')
  expect(card.activeKey).toBe('b')
  card.close('b')
  card.enter('b', 'mouse')
  card.close('a')
  vi.advanceTimersByTime(ROW_HOVER_CARD_OPEN_DELAY_MS)
  expect(card.activeKey).toBe('b')
})

it('rows drawn by others are known by a selector', () => {
  const rail = new RowHoverCardController('rail', '[data-rail] [data-slot="list-row"]')
  const list = document.createElement('div')
  list.setAttribute('data-rail', '')
  const row = document.createElement('div')
  row.setAttribute('data-slot', 'list-row')
  list.append(row)
  document.body.append(list)
  rail.open('a')
  rail.leave('a', row)
  expect(rail.activeKey).toBe('a')
  list.removeAttribute('data-rail')
  rail.leave('a', row)
  expect(rail.activeKey, 'the list is open, not a rail: its rows are not this card').toBeNull()
})

it('tells subscribers each time the open card changes', () => {
  const seen: (string | null)[] = []
  const stop = card.subscribe(() => seen.push(card.readActive()))
  card.open('a')
  card.enter('b', 'mouse')
  card.leave('b', null)
  stop()
  card.open('a')
  expect(seen).toEqual(['a', 'b', null])
})
