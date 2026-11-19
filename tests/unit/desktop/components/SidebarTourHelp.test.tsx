// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clickElement, createNode, createReactHarness, renderWithAppProviders } from '../../../support/testHarness'

vi.mock('../../../../apps/desktop/src/platform', async (original) => {
  const actual = await original<typeof import('../../../../apps/desktop/src/platform')>()
  return { ...actual, platform: { ...actual.platform, kind: 'electron' } }
})
const progress = vi.hoisted(() => ({ value: null as null | { step: 'chats'; status: 'skipped' } }))
vi.mock('../../../../apps/desktop/src/lib/productTour', async (original) => ({
  ...await original<Record<string, unknown>>(), useProductTourState: () => ({ data: progress.value }),
}))
const { Sidebar } = await import('../../../../apps/desktop/src/components/Sidebar')
const { HelpSection } = await import('../../../../apps/desktop/src/components/settings/HelpSection')
const { i18n } = await import('../../../../apps/desktop/src/i18n/runtime')
const { UI_EVENTS } = await import('../../../../apps/desktop/src/lib/uiEvents')

beforeEach(async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  await i18n.changeLanguage('zh-CN')
})
afterEach(() => { progress.value = null; vi.unstubAllGlobals() })

describe('Help and tour in settings', () => {
  it.each([false, true])('preserves restart/resume, hides films and removes the rail entry (resumable: %s)', async (resumable) => {
    progress.value = resumable ? { step: 'chats', status: 'skipped' } : null
    const h = createReactHarness()
    const requests: unknown[] = []
    const capture = (event: Event) => requests.push((event as CustomEvent).detail)
    const closed = () => requests.push('close-settings')
    window.addEventListener(UI_EVENTS.reopenProductTour, capture)
    window.addEventListener(UI_EVENTS.closeSettings, closed)
    try {
      await renderWithAppProviders(h, createNode('div', null,
        createNode(Sidebar, { activeTab: 'tasks', onTabChange: vi.fn() }), createNode(HelpSection)))
      expect(h.container.querySelector('[data-rail="help"]')).toBeNull()
      expect(h.container.textContent).not.toContain('看功能短片')
      const resume = h.container.querySelector<HTMLElement>('[data-testid="help-tour-resume"]')
      expect(resume?.textContent?.includes('继续导览 2 / 6') ?? false).toBe(resumable)
      if (resume) await clickElement(resume)
      await clickElement(h.container.querySelector('[data-testid="help-tour-restart"]')!)
      expect(requests).toEqual([
        ...(resumable ? ['close-settings', { mode: 'resume', step: 'chats' }] : []),
        'close-settings', { mode: 'restart' },
      ])
    } finally {
      window.removeEventListener(UI_EVENTS.reopenProductTour, capture)
      window.removeEventListener(UI_EVENTS.closeSettings, closed)
      h.cleanup()
    }
  })
  it('keeps the original feedback event and one feedback group below the tour rows', async () => {
    const h = createReactHarness()
    const feedback = vi.fn()
    window.addEventListener(UI_EVENTS.sessionpageOpenFeedback, feedback)
    try {
      await renderWithAppProviders(h, createNode(HelpSection))
      const entries = h.container.querySelectorAll<HTMLElement>('[data-testid="about-feedback"]')
      expect(entries).toHaveLength(1)
      expect(entries[0].textContent).toContain('问题反馈')
      await clickElement(entries[0])
      expect(feedback).toHaveBeenCalledOnce()
    } finally { window.removeEventListener(UI_EVENTS.sessionpageOpenFeedback, feedback); h.cleanup() }
  })
})
