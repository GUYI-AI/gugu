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
const { i18n } = await import('../../../../apps/desktop/src/i18n/runtime')

const box = (x: number, y: number, width: number, height: number) => () => ({ width, height, x, y, top: y, left: x, right: x + width, bottom: y + height, toJSON() {} }) as DOMRect
let rail: HTMLElement
beforeEach(async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  await i18n.changeLanguage('zh-CN')
  rail = document.createElement('nav')
  rail.className = 'gg-sidebar-rail'
  for (const [i, name] of ['assistant', 'chats', 'contacts', 'library', 'apps', 'settings'].entries()) {
    const button = document.createElement('button')
    button.dataset.rail = name
    button.getBoundingClientRect = box(0, 20 + i * 48, 40, 40)
    button.scrollIntoView = vi.fn()
    rail.append(button)
  }
  for (const page of ['projects', 'chats']) {
    const button = document.createElement('button')
    button.dataset.testid = `sidebar-list-page-${page}`
    button.getBoundingClientRect = box(60, 20, 80, 32)
    button.scrollIntoView = vi.fn()
    rail.append(button)
  }
  document.body.append(rail)
})
afterEach(() => { rail.remove(); document.querySelector('[data-tour="sample-project"]')?.remove(); vi.clearAllMocks(); vi.unstubAllGlobals() })

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
    document.body.append(sample)
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
  it('keeps Next available when the sample was already removed', async () => {
    const h = await mount('tasks')
    try {
      expect(h.card().textContent).toContain('一件事的会话和文件都放在这里。')
      await clickElement(h.button('next')!)
      expect(h.card().dataset.testid).toBe('product-tour-step-chats')
    } finally { h.cleanup() }
  })
  it('uses the real project heading when a merged list has no sample or page tab', async () => {
    rail.querySelector('[data-testid="sidebar-list-page-projects"]')!.remove()
    const heading = document.createElement('div')
    heading.dataset.firstRunHint = 'collaboration'
    heading.dataset.firstRunDevice = 'desktop'
    heading.getBoundingClientRect = box(60, 120, 220, 32)
    heading.scrollIntoView = vi.fn()
    rail.append(heading)
    const h = await mount('tasks')
    try {
      expect(h.card().dataset.testid).toBe('product-tour-step-tasks')
      await clickElement(h.button('next')!)
      expect(h.card().dataset.testid).toBe('product-tour-step-chats')
    } finally { h.cleanup() }
  })
  it.each([false, true])('skips an unavailable project anchor without trapping or revisiting the step (lost during tour=%s)', async (during) => {
    const projects = rail.querySelector('[data-testid="sidebar-list-page-projects"]')!
    if (!during) projects.remove()
    const h = await mount('tasks')
    try {
      if (during) await act(async () => { projects.remove() })
      await settleTargets()
      await waitForCondition(() => document.querySelector('[data-testid="product-tour-step-chats"]') !== null, 'continued without a project anchor')
      expect(h.card().textContent).toContain('2 / 6')
      await clickElement(h.button('previous')!)
      expect(h.card().dataset.testid).toBe('product-tour-step-assistant')
      await clickElement(h.button('next')!)
      expect(h.card().dataset.testid).toBe('product-tour-step-chats')
    } finally { h.cleanup() }
  })
  it('continues when the highlighted sample disappears during step 2', async () => {
    const sample = document.createElement('div')
    sample.dataset.tour = 'sample-project'
    sample.getBoundingClientRect = box(60, 200, 220, 36)
    sample.scrollIntoView = vi.fn()
    rail.append(sample)
    const h = await mount('tasks')
    try {
      await act(async () => { sample.remove() })
      await settleTargets()
      await waitForCondition(() => h.card()?.textContent?.includes('一件事的会话和文件都放在这里。') === true, 'project fallback shown')
      await clickElement(h.button('next')!)
      expect(h.card().dataset.testid).toBe('product-tour-step-chats')
    } finally { h.cleanup() }
  })
  it('finishes once when no supplied step has a real anchor', async () => {
    rail.remove()
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
