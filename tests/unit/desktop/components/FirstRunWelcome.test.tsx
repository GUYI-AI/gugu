// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createNode, createReactHarness } from '../../../support/testHarness'

const { FirstRunWelcome } = await import('../../../../apps/desktop/src/components/firstRun/FirstRunWelcome')
const { AssistantIntro } = await import('../../../../apps/desktop/src/components/assistant/AssistantIntro')
const { i18n } = await import('../../../../apps/desktop/src/i18n/runtime')

// #1931 F1 The first run's introduction is the host's page; the words about the assistant come from its rules (`intro`).
// Given the words the assistant's own introduction shows (that component, still used by its setup, is the baseline here),
// it renders exactly what that component renders, for both languages, both screens and both layouts.
const cleanup: (() => void)[] = []
afterEach(() => { while (cleanup.length) cleanup.pop()!() })

function setDevice(device: 'phone' | 'desktop') {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: device === 'phone' ? 390 : 1280 })
}

async function html(node: Parameters<ReturnType<typeof createReactHarness>['render']>[0]) {
  const h = createReactHarness()
  cleanup.push(h.cleanup)
  await h.render(node)
  return h.container
}

const actions = { primaryLabel: 'P', onPrimary: vi.fn(), laterLabel: 'L', onLater: vi.fn(), backLabel: 'B', onBack: vi.fn(), busy: false, error: null }

describe('the first run introduction', () => {
  for (const locale of ['zh-CN', 'en-US'] as const) for (const device of ['phone', 'desktop'] as const) {
    it(`${locale} ${device}: with the rules' words it is the page it was, element for element`, async () => {
      await i18n.changeLanguage(locale)
      setDevice(device)
      const words = i18n.getFixedT(locale, 'assistant')
      const copy = { title: words('intro.title'), summary: 'One sentence about the assistant.', desktopBody: words('intro.desktop.guguBody'), phoneBody: words('intro.phone.guguBody') }
      const before = await html(createNode(AssistantIntro, actions))
      const after = await html(createNode(FirstRunWelcome, { ...actions, copy, summaryOnly: false }))
      expect(after.innerHTML).toBe(before.innerHTML)
      const summaryBefore = await html(createNode(AssistantIntro, { ...actions, summary: copy.summary }))
      const summaryAfter = await html(createNode(FirstRunWelcome, { ...actions, copy, summaryOnly: true }))
      expect(summaryAfter.innerHTML).toBe(summaryBefore.innerHTML)
    })
  }

  it('without the words in the person\'s language: the host\'s neutral heading and nothing about the assistant', async () => {
    await i18n.changeLanguage('zh-CN')
    setDevice('phone')
    const rows = await html(createNode(FirstRunWelcome, { ...actions, copy: null, summaryOnly: false }))
    expect(rows.querySelector('.ta-onb-title')?.textContent).toBe('欢迎使用咕咕')
    expect([...rows.querySelectorAll('[data-intro-row]')].map((row) => row.getAttribute('data-intro-row'))).toEqual(['messages', 'partners'])
    const summary = await html(createNode(FirstRunWelcome, { ...actions, copy: null, summaryOnly: true }))
    expect(summary.querySelector('.ta-onb-sub')).toBeNull()
    expect(summary.querySelector('[data-testid="assistant-intro-primary"]')?.textContent).toBe('P')
  })
})
