import { useRef } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { createReactHarness } from '../../../../../../../tests/support/testHarness'
import { until } from '../../../../../../../tests/support/awaitCondition'

// The pill's card content reads live chat stores; what is judged here is the card around it, so the content is a stand-in.
vi.mock('@/components/MessagePreviewCard', () => ({
  MessagePreviewCard: ({ token }: { token: { id: string } }) => <div data-preview-of={token.id} style={{ width: 240, height: 80 }}>{token.id}</div>,
}))

import { ListRow } from '@/components/ui/ListRow'
import { ROW_HOVER_CARD_OPEN_DELAY_MS } from '@/components/ui/rowHoverCardController'
import { RunningTokenBar, type RunningToken } from '@/components/RunningTokenBar'
import { RailRowHint } from '@renderer/features/sidebar/rail-row-hint'
import '@/styles/tokens.css'

/**
 * Pointing at an object in a list opens the same card everywhere (owner 2026-11-24: the main sidebar's group / person rows
 * and the running-agent pills behave as a group's agent rows). Real Chromium and the engine's pointer; the product's
 * timing is an input (fake setTimeout), never a wall-clock wait.
 */

let harness: ReturnType<typeof createReactHarness>
beforeEach(async () => {
  await page.viewport(1000, 700)
})
afterEach(() => {
  vi.useRealTimers()
  harness?.cleanup()
})

const token = (id: string): RunningToken => ({ id, name: id, avatarUrl: null, avatarSeed: id, stateKey: 'running', toolCount: 0, lastActiveAt: null })

function Surfaces() {
  const list = useRef<HTMLDivElement>(null)
  return (
    <>
      <div ref={list} data-sidebar-rail="" style={{ position: 'fixed', left: 0, top: 0, width: 72 }}>
        <RailRowHint list={list} enabled />
        <ListRow data-row="group" leading={<span style={{ display: 'block', width: 32, height: 32 }} />} title="Weekend hikers" subtitle="See you at eight" />
        <ListRow data-row="person" leading={<span style={{ display: 'block', width: 32, height: 32 }} />} title="Lin" />
      </div>
      <div style={{ position: 'fixed', left: 300, top: 500, width: 600 }}>
        <RunningTokenBar tokens={[token('alpha'), token('beta')]} previewChatId="chat-1" />
      </div>
      <div data-park="" style={{ position: 'fixed', right: 0, bottom: 0, width: 80, height: 80 }} />
    </>
  )
}

const railCard = () => document.querySelector<HTMLElement>('[data-row-hover-card="sidebar-rail"]')
const pillCard = () => document.querySelector<HTMLElement>('[data-row-hover-card="running-agent"]')
const railRow = (name: string) => document.querySelector<HTMLElement>(`[data-row="${name}"]`)!
const pill = (id: string) => document.querySelector<HTMLElement>(`.rtb-bar > [data-message-preview-trigger="${id}"]`)!
const park = () => document.querySelector<HTMLElement>('[data-park]')!

/** Two frames: whatever the last timer committed has rendered. */
const painted = () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))

async function mount() {
  harness = createReactHarness()
  await harness.render(<Surfaces />)
  await until('both lists are laid out', () => railRow('person') !== null && pill('beta')?.getBoundingClientRect().width > 0)
  await userEvent.hover(park())
}

const surfaces = [
  { name: 'rail group / person rows', side: 'right', card: railCard, a: () => railRow('group'), b: () => railRow('person'), text: ['Weekend hikersSee you at eight', 'Lin'] },
  { name: 'running-agent pills', side: 'top', card: pillCard, a: () => pill('alpha'), b: () => pill('beta'), text: ['alpha', 'beta'] },
]

for (const surface of surfaces) {
  it(`${surface.name}: opens after the same rest, swaps at once, keeps while the pointer is on the card, closes at once on leaving`, async () => {
    await mount()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })

    await userEvent.hover(surface.a())
    vi.advanceTimersByTime(ROW_HOVER_CARD_OPEN_DELAY_MS - 1)
    await painted()
    expect(surface.card(), 'not before the rest is over').toBeNull()
    vi.advanceTimersByTime(1)
    await until('the card opens', surface.card, (card) => card?.textContent === surface.text[0])

    await userEvent.hover(surface.b())
    expect(vi.getTimerCount(), 'the warm swap waits for nothing').toBe(0)
    await until('the next object takes the card at once', surface.card, (card) => card?.textContent === surface.text[1])
    // …and the card is beside that object now, not still where the first one was.
    await until('the card has settled', () => surface.card()!.getAnimations({ subtree: true }).length === 0)
    const next = surface.b().getBoundingClientRect()
    const face = surface.card()!.firstElementChild!.getBoundingClientRect()
    if (surface.side === 'right') expect(face.top < next.bottom && face.bottom > next.top, 'level with the row it is for').toBe(true)
    else expect(Math.abs(face.left - next.left) < 1, 'starts at the pill it is for').toBe(true)

    // Into the card: it stays (no timer can be what keeps it — the clock is frozen).
    await userEvent.hover(surface.card()!)
    await painted()
    expect(surface.card()?.textContent).toBe(surface.text[1])

    await userEvent.hover(park())
    expect(vi.getTimerCount(), 'leaving closes without a grace timer').toBe(0)
    await until('the card is gone', surface.card, (card) => card === null)
  })

  it(`${surface.name}: a press closes the card and it does not come back while the pointer stays`, async () => {
    await mount()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    await userEvent.hover(surface.a())
    vi.advanceTimersByTime(ROW_HOVER_CARD_OPEN_DELAY_MS)
    await until('the card opens', surface.card, (card) => card !== null)
    surface.a().dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse' }))
    await until('the press closes it', surface.card, (card) => card === null)
    vi.advanceTimersByTime(ROW_HOVER_CARD_OPEN_DELAY_MS * 3)
    await painted()
    expect(surface.card()).toBeNull()
  })
}

it('the rail card and the pill card are one card: same surface, same motion', async () => {
  await mount()
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  await userEvent.hover(railRow('group'))
  vi.advanceTimersByTime(ROW_HOVER_CARD_OPEN_DELAY_MS)
  await until('rail card', railCard, (card) => card !== null)
  const rail = railCard()!.className
  await userEvent.hover(park())
  await userEvent.hover(pill('alpha'))
  vi.advanceTimersByTime(ROW_HOVER_CARD_OPEN_DELAY_MS)
  await until('pill card', pillCard, (card) => card !== null)
  // The popup's classes differ only by which side it opens on (data-side picks the padding and the slide), so compare the list.
  expect(pillCard()!.className).toBe(rail)
  expect(railCard()).toBeNull()
})
