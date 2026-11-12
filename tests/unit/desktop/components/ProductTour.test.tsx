// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clickElement, createNode, createReactHarness, waitForCondition } from '../../../support/testHarness'

const io = vi.hoisted(() => ({ save: vi.fn(async (_userId: string, _state: unknown): Promise<void> => undefined) }))
vi.mock('../../../../apps/desktop/src/lib/productTour', async (original) => ({
  ...await original<Record<string, unknown>>(), saveProductTourState: io.save, useRememberProductTourState: () => () => undefined,
}))
vi.mock('../../../../apps/desktop/src/lib/supabase', () => ({ identityDb: {} }))
// The primitive owns floating geometry; this suite measures the workflow, not jsdom's zero-sized layout.
vi.mock('../../../../apps/desktop/src/components/ui/Popover', () => ({
  Popover: { Arrow: () => createNode('i', { 'data-testid': 'tour-arrow' }), Root: ({ children }: { children: unknown }) => children, Portal: ({ children }: { children: unknown }) => children,
    Positioner: ({ children }: { children: unknown }) => children,
    Popup: ({ children, ...props }: { children: unknown; 'data-testid'?: string; role?: string; ref?: import('react').Ref<HTMLElement> }) => createNode('section', { ref: props.ref, tabIndex: -1, 'data-testid': props['data-testid'], role: props.role }, children as never) },
}))
const { ProductTour } = await import('../../../../apps/desktop/src/components/productTour/ProductTour')
const { availableTourSteps } = await import('../../../../apps/desktop/src/components/productTour/tourTargets')
const { publishPanelToggle } = await import('../../../../apps/desktop/src/lib/panelToggles')
const { useProductTourOnScreen } = await import('../../../../apps/desktop/src/lib/sidebarChatsBridge')
const { i18n } = await import('../../../../apps/desktop/src/i18n/runtime')

const box = (x: number, y: number, width: number, height: number) => () => ({ width, height, x, y, top: y, left: x, right: x + width, bottom: y + height, toJSON() {} }) as DOMRect
const place = <T extends HTMLElement>(element: T, rect: () => DOMRect) => { element.getBoundingClientRect = rect; element.scrollIntoView = vi.fn(); return element }
let rail: HTMLElement
/** The task page's one-list sidebar (#2548): 创建智能体 on top, the list's scroller under it. */
let sidebar: HTMLElement
let createAgent: HTMLElement
let list: HTMLElement
beforeEach(async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  await i18n.changeLanguage('zh-CN')
  rail = document.createElement('nav')
  rail.className = 'gg-sidebar-rail'
  for (const [i, name] of ['assistant', 'chats', 'contacts', 'library', 'apps', 'settings'].entries()) {
    const button = place(document.createElement('button'), box(0, 20 + i * 48, 40, 40))
    button.dataset.rail = name
    rail.append(button)
  }
  document.body.append(rail)
  sidebar = place(document.createElement('div'), box(60, 0, 260, 700))
  sidebar.dataset.region = 'left-sidebar'
  createAgent = place(document.createElement('button'), box(72, 52, 200, 32))
  createAgent.dataset.testid = 'sidebar-create-agent'
  list = place(document.createElement('div'), box(60, 92, 260, 560))
  list.dataset.region = 'sidebar-scroll'
  sidebar.append(createAgent, list)
  document.body.append(sidebar)
})
afterEach(() => { rail.remove(); sidebar.remove(); document.querySelector('[data-tour="sample-project"]')?.remove(); vi.clearAllMocks(); vi.unstubAllGlobals() })
/** Where the spotlight's ring is: the target's box, PAD + 1 outside it. */
const ring = () => {
  const rect = document.querySelector('.product-tour-ring rect')!
  return { x: Number(rect.getAttribute('x')) + 9, y: Number(rect.getAttribute('y')) + 9 }
}

const STEPS = ['assistant', 'tasks', 'chats', 'contacts', 'library', 'apps', 'settings'] as const
async function settleTargets() {
  // A missing entry can advance once per measured frame; keep those DOM observer
  // updates inside React's interaction boundary, including an entirely absent tour.
  for (let at = 0; at < STEPS.length; at++) await act(async () => { await new Promise<void>((resolve) => requestAnimationFrame(() => resolve())) })
}
async function mount(start: (typeof STEPS)[number] = 'assistant', steps: readonly string[] = STEPS) {
  const harness = createReactHarness()
  const done = vi.fn()
  try {
    await harness.render(createNode(ProductTour, { userId: 'owner-1', steps, start, onDone: done }))
    await settleTargets()
    await waitForCondition(() => !!document.querySelector('[data-testid^="product-tour-step-"]'), 'card shown')
  } catch (error) { harness.cleanup(); throw error }
  const button = (id: string) => document.querySelector<HTMLButtonElement>(`[data-testid="product-tour-${id}"]`)
  const card = () => document.querySelector<HTMLElement>('[data-testid^="product-tour-step-"]')!
  return { ...harness, done, button, card }
}
const key = (k: string) => act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true })) })

describe('feature-bar coach marks (onboarding spec §2)', () => {
  it('expands the existing list controller before starting a tour from a collapsed sidebar', async () => {
    const toggle = vi.fn()
    const release = publishPanelToggle('list:sessions', { open: false, label: 'Expand sidebar', toggle })
    try {
      availableTourSteps()
      expect(toggle).toHaveBeenCalledOnce()
    } finally { release() }
  })
  it('points an arrow at a real entry, spotlights it, and shows n / N with Skip and Next but no Back on step 1', async () => {
    const h = await mount()
    try {
      expect(h.card().dataset.testid).toBe('product-tour-step-assistant')
      expect(h.card().getAttribute('role')).toBe('dialog')
      expect(h.card().querySelector('[data-testid="tour-arrow"]')).not.toBeNull()
      expect(document.querySelector('[data-testid="product-tour-spotlight"]')).not.toBeNull()
      expect(h.card().textContent).toContain('1 / 7')
      expect(h.card().textContent).toContain('咕咕：你的个人助理')
      expect(h.button('previous')).toBeNull()
      expect(h.button('skip')).not.toBeNull()
      await clickElement(h.button('next')!)
      expect(h.card().textContent).toContain('2 / 7')
      expect(h.button('previous')).not.toBeNull()
      expect(io.save).toHaveBeenLastCalledWith('owner-1', { step: 'tasks', status: 'active' })
    } finally { h.cleanup() }
  })
  it('ends with Done and no Skip, and records the tour as seen', async () => {
    const h = await mount('settings')
    try {
      expect(h.card().textContent).toContain('7 / 7')
      expect(h.button('skip')).toBeNull()
      expect(h.button('next')!.textContent).toBe('完成')
      await clickElement(h.button('next')!)
      expect(h.done).toHaveBeenCalledOnce()
      expect(io.save).toHaveBeenLastCalledWith('owner-1', { step: 'settings', status: 'done' })
    } finally { h.cleanup() }
  })
  it('tells the task page it is on screen while it shows (#2548: the sidebar intro steps aside), and not after', async () => {
    const seen = { onScreen: false }
    function Probe() { seen.onScreen = useProductTourOnScreen(); return null }
    const probe = createReactHarness()
    await probe.render(createNode(Probe, {}))
    try {
      expect(seen.onScreen).toBe(false)
      const h = await mount()
      await waitForCondition(() => seen.onScreen, 'on screen while the tour shows')
      h.cleanup()
      await waitForCondition(() => !seen.onScreen, 'off once it is gone')
    } finally { probe.cleanup() }
  })
  it('follows Enter, →, ← and Esc; Esc skips and remembers where it stopped', async () => {
    const h = await mount()
    try {
      await key('Enter')
      await key('ArrowRight')
      expect(h.card().textContent).toContain('3 / 7')
      await key('ArrowLeft')
      expect(h.card().textContent).toContain('2 / 7')
      await key('Escape')
      expect(h.done).toHaveBeenCalledOnce()
      expect(io.save).toHaveBeenLastCalledWith('owner-1', { step: 'tasks', status: 'skipped' })
    } finally { h.cleanup() }
  })
  it('returns keyboard focus to the card after advancing from an activated ordinary target', async () => {
    const h = await mount()
    try {
      const target = rail.querySelector<HTMLElement>('[data-rail="assistant"]')!
      await clickElement(target)
      target.focus()
      expect(h.card().textContent).toContain('1 / 7')
      await key('ArrowRight')
      expect(h.card().textContent).toContain('2 / 7')
      expect(document.activeElement).toBe(h.button('next'))
    } finally { h.cleanup() }
  })
  it('ignores clicks on the dimmed area', async () => {
    const h = await mount()
    try {
      const shade = document.querySelector<HTMLElement>('.product-tour-shade')!
      await clickElement(shade)
      expect(h.card().textContent).toContain('1 / 7')
      expect(h.done).not.toHaveBeenCalled()
    } finally { h.cleanup() }
  })
  it('lets the settings dialog handle keyboard input without advancing or closing the tour', async () => {
    const settings = document.createElement('div')
    settings.dataset.settingsModalCard = ''
    const theme = document.createElement('button')
    settings.append(theme)
    document.body.append(settings)
    const h = await mount('settings')
    try {
      for (const k of ['ArrowRight', 'Enter', 'Escape']) {
        await act(async () => { theme.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true })) })
      }
      expect(h.done).not.toHaveBeenCalled()
      expect(h.card().textContent).toContain('7 / 7')
    } finally { h.cleanup(); settings.remove() }
  })
  it.each(['next', 'Enter', 'ArrowRight', 'sample'])('lets the sample step continue using %s', async (action) => {
    const sample = document.createElement('div')
    sample.dataset.tour = 'sample-project'
    sample.getBoundingClientRect = box(60, 200, 220, 36)
    sample.scrollIntoView = vi.fn()
    list.append(sample)
    const h = await mount('tasks')
    try {
      expect(h.button('next')).not.toBeNull()
      expect(h.card().textContent).toContain('或点「下一步」继续')
      expect(h.button('skip')).not.toBeNull()
      expect(h.button('previous')).not.toBeNull()
      if (action === 'next') await clickElement(h.button('next')!)
      else if (action === 'sample') await clickElement(sample)
      else await key(action)
      await waitForCondition(() => h.card().textContent!.includes('3 / 7'), 'advanced from the sample step')
      expect(io.save.mock.calls.filter(([, state]) => (state as { step: string }).step === 'chats')).toHaveLength(1)
    } finally { h.cleanup() }
  })
  it('without the sample it points at 创建智能体 (no click action), and Next goes on', async () => {
    const h = await mount('tasks')
    try {
      expect(ring()).toEqual({ x: 72, y: 52 })
      expect(h.card().querySelector('h2')!.textContent).toBe('创建智能体')
      expect(h.card().textContent).toContain('写一句需求，就多一个智能体；它会出现在左边的列表里。')
      await clickElement(createAgent)
      expect(h.card().dataset.testid).toBe('product-tour-step-tasks')
      await clickElement(h.button('next')!)
      expect(h.card().dataset.testid).toBe('product-tour-step-chats')
    } finally { h.cleanup() }
  })
  it('the sample row comes first when it is there, with its own copy', async () => {
    const sample = place(document.createElement('div'), box(60, 300, 260, 56))
    sample.dataset.tour = 'sample-project'
    list.append(sample)
    const h = await mount('tasks')
    try {
      expect(ring()).toEqual({ x: 60, y: 300 })
      expect(h.card().querySelector('h2')!.textContent).toBe('项目：集中推进一件事')
    } finally { h.cleanup() }
  })
  it('对话 points at the one list itself, ❌ a header or a page tab', async () => {
    const h = await mount('chats')
    try {
      expect(ring()).toEqual({ x: 60, y: 92 })
      expect(h.card().querySelector('h2')!.textContent).toBe('对话')
      expect(h.card().textContent).toContain('智能体、群、项目和人都在这一列，按最近动静排；有事找你的会挂红数字。')
    } finally { h.cleanup() }
  })
  it.each([false, true])('skips an unavailable 创建智能体 without trapping or revisiting the step (lost during tour=%s)', async (during) => {
    if (!during) createAgent.remove()
    const h = await mount('tasks')
    try {
      if (during) await act(async () => { createAgent.remove() })
      await settleTargets()
      await waitForCondition(() => document.querySelector('[data-testid="product-tour-step-chats"]') !== null, 'continued without 创建智能体')
      expect(h.card().textContent).toContain('2 / 6')
      await clickElement(h.button('previous')!)
      expect(h.card().dataset.testid).toBe('product-tour-step-assistant')
      await clickElement(h.button('next')!)
      expect(h.card().dataset.testid).toBe('product-tour-step-chats')
    } finally { h.cleanup() }
  })
  it('continues when the highlighted sample disappears during step 2', async () => {
    const sample = place(document.createElement('div'), box(60, 200, 220, 36))
    sample.dataset.tour = 'sample-project'
    list.append(sample)
    const h = await mount('tasks')
    try {
      await act(async () => { sample.remove() })
      await settleTargets()
      await waitForCondition(() => h.card()?.textContent?.includes('写一句需求，就多一个智能体') === true, '创建智能体 fallback shown')
      await clickElement(h.button('next')!)
      expect(h.card().dataset.testid).toBe('product-tour-step-chats')
    } finally { h.cleanup() }
  })
  it('the sidebar on screen without the entry: ❌ 消息 (on the task page it folds the sidebar), the step goes', async () => {
    createAgent.remove()
    const messages = rail.querySelector<HTMLElement>('[data-rail="chats"]')!
    const clicked = vi.fn()
    messages.addEventListener('click', clicked)
    const h = await mount('tasks')
    try {
      await settleTargets()
      await waitForCondition(() => document.querySelector('[data-testid="product-tour-step-chats"]') !== null, 'went on without 创建智能体')
      expect(clicked).not.toHaveBeenCalled()
    } finally { h.cleanup() }
  })
  it('the sidebar collapsed: unfolds it by its own controller, ❌ 消息', async () => {
    const messages = rail.querySelector<HTMLElement>('[data-rail="chats"]')!
    const clicked = vi.fn()
    messages.addEventListener('click', clicked)
    let open = false
    const release = publishPanelToggle('list:sessions', { open: false, label: 'Expand sidebar', toggle: () => { open = true; republish() } })
    let releaseOpen = () => {}
    const republish = () => { release(); releaseOpen = publishPanelToggle('list:sessions', { open, label: 'Collapse sidebar', toggle: () => {} }) }
    try {
      const h = await mount('tasks')
      try {
        expect(open).toBe(true)
        expect(clicked).not.toHaveBeenCalled()
        expect(h.card().dataset.testid).toBe('product-tour-step-tasks')
      } finally { h.cleanup() }
    } finally { release(); releaseOpen() }
  })
  it('started from the collapsed sidebar: waits while it unfolds (创建智能体 still 0 wide), ❌ drops the step', async () => {
    const release = publishPanelToggle('list:sessions', { open: true, label: 'Collapse sidebar', toggle: () => {} })
    sidebar.style.setProperty('--gg-sidebar-progress', '0.2')
    const settled = createAgent.getBoundingClientRect
    createAgent.getBoundingClientRect = box(72, 52, 0, 32)
    const harness = createReactHarness()
    try {
      await harness.render(createNode(ProductTour, { userId: 'owner-1', steps: STEPS, start: 'tasks', onDone: vi.fn() }))
      await settleTargets()
      expect(document.querySelector('[data-testid^="product-tour-step-"]')).toBeNull()
      await act(async () => {
        sidebar.style.setProperty('--gg-sidebar-progress', '1')
        createAgent.getBoundingClientRect = settled
      })
      await settleTargets()
      await waitForCondition(() => document.querySelector('[data-testid="product-tour-step-tasks"]') !== null, 'the tasks step after unfolding')
      expect(document.querySelector('[data-testid="product-tour-step-tasks"]')!.textContent).toContain('2 / 7')
    } finally { harness.cleanup(); release() }
  })
  it('the sidebar off screen (another tab is up): 消息 brings the task page up', async () => {
    sidebar.remove()
    const messages = rail.querySelector<HTMLElement>('[data-rail="chats"]')!
    messages.addEventListener('click', () => document.body.append(sidebar))
    const h = await mount('tasks')
    try {
      expect(h.card().dataset.testid).toBe('product-tour-step-tasks')
      expect(ring()).toEqual({ x: 72, y: 52 })
    } finally { h.cleanup() }
  })
  it('finishes once when no supplied step has a real anchor', async () => {
    rail.remove()
    sidebar.remove()
    const harness = createReactHarness()
    const done = vi.fn()
    try {
      await harness.render(createNode(ProductTour, { userId: 'owner-1', steps: STEPS, start: 'assistant', onDone: done }))
      await settleTargets()
      await waitForCondition(() => done.mock.calls.length === 1, 'unavailable tour finished')
      expect(document.querySelector('[data-testid^="product-tour-step-"]')).toBeNull()
      expect(io.save).toHaveBeenLastCalledWith('owner-1', { step: 'settings', status: 'done' })
    } finally { harness.cleanup() }
  })
  it('counts only the steps it was given', async () => {
    const h = await mount('assistant', ['assistant', 'tasks', 'chats', 'contacts', 'settings'])
    try { expect(h.card().textContent).toContain('1 / 5') } finally { h.cleanup() }
  })
})
