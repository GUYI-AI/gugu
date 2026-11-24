import { useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { ChatComposer } from '@gugu/session-ui/react/components'
import { SessionLocalizationProvider } from '@renderer/localization/localization-provider'
import { renderFastModeHint } from '@renderer/features/sessions/session-config/fast-mode-hint'
import { Tooltip } from '@/components/ui/Tooltip'
import { i18n } from '@/i18n'
import { until } from '../../../../../../../tests/support/awaitCondition'
import '@gugu/session-ui/styles/global'
import '@gugu/session-ui/theme/theme.css'
import '@gugu/session-ui/theme/semantic.css'
import '@gugu/session-ui/styles/base.css'
import '@/styles/tokens.css'
import '@renderer/index.css'

let root: Root
let container: HTMLDivElement
let previousLanguage: string
const changed = vi.fn()
const effortChanged = vi.fn()
const modelChanged = vi.fn()
const fast = () => document.querySelector<HTMLElement>('[data-fast-mode-toggle]')
const detailSwitch = () => page.getByRole('switch', { name: 'Fast', exact: true })

function Fixture({ supported = true, mobile = false, initial = false, phoneActions = mobile }: {
  supported?: boolean; mobile?: boolean; initial?: boolean; phoneActions?: boolean
}) {
  const [enabled, setEnabled] = useState(initial)
  return <Tooltip.Provider><SessionLocalizationProvider><ChatComposer
    mobile={mobile}
    phoneActions={phoneActions}
    modelOptions={{ own: { name: 'Native model' } }} selectedModel="own" onModelChange={modelChanged}
    effortOptions={{ low: { name: 'Low' }, medium: { name: 'Medium' }, high: { name: 'High' } }}
    selectedEffort="medium" onEffortChange={effortChanged}
    fastMode={supported ? enabled : undefined}
    onFastModeChange={value => { changed(value); setEnabled(value) }}
    renderFastModeHint={renderFastModeHint}
    onSubmit={() => {}} onStop={() => {}}
  /></SessionLocalizationProvider></Tooltip.Provider>
}

async function renderMenu(props: Parameters<typeof Fixture>[0] = {}) {
  root.render(<Fixture {...props} />)
  await page.getByTestId('composer-model-trigger').click()
  await until('model menu mounted', () => document.querySelector('[data-slot="combobox-content"]') != null)
  const panel = document.querySelector<HTMLElement>('[data-slot="combobox-content"]')!
  await until('model menu entered', () => !panel.hasAttribute('data-starting-style'))
  await Promise.all(panel.getAnimations().map(animation => animation.finished))
  if (props.phoneActions ?? props.mobile) {
    await until('phone thinking slider mounted', () => document.querySelector('[data-slot="composer-effort-indicator"]') != null)
  } else {
    await page.getByRole('option', { name: 'Native model' }).hover()
    const detailSelector = '[data-hover-card]:has([data-slot="composer-model-detail"])'
    await until('desktop model details entered', () => document.querySelector(`${detailSelector}:not([data-starting-style])`) != null)
    await Promise.all(document.querySelector(detailSelector)!.getAnimations({ subtree: true }).map(animation => animation.finished))
  }
}

describe('Fast in the real thinking menu', () => {
  beforeEach(async () => {
    previousLanguage = i18n.language
    await i18n.changeLanguage('en-US')
    vi.clearAllMocks()
    await page.viewport(1100, 800)
    document.body.classList.add('emdark', 'gugu-skin')
    document.documentElement.dataset.theme = 'dark'
    container = document.createElement('div')
    container.style.cssText = 'width:700px;position:absolute;left:100px;bottom:24px'
    document.body.append(container)
    root = createRoot(container)
  })
  afterEach(async () => {
    root.unmount()
    container.remove()
    document.body.classList.remove('emdark', 'gugu-skin')
    delete document.documentElement.dataset.theme
    await i18n.changeLanguage(previousLanguage)
  })

  it('starts off, toggles both ways and leaves model, effort and menu unchanged', async () => {
    await renderMenu()
    await expect.element(detailSwitch()).not.toBeChecked()
    await detailSwitch().click()
    await expect.element(detailSwitch()).toBeChecked()
    expect(changed.mock.calls).toEqual([[true]])
    await detailSwitch().click()
    await expect.element(detailSwitch()).not.toBeChecked()
    expect(changed.mock.calls).toEqual([[true], [false]])
    expect(effortChanged).not.toHaveBeenCalled()
    expect(modelChanged).not.toHaveBeenCalled()
    expect(container.querySelector('[data-fast-mode-toggle]')).toBeNull()
  })

  it('renders no Fast control or reserved row for an unsupported model', async () => {
    await renderMenu({ supported: false })
    expect(fast()).toBeNull()
    expect(document.querySelector('[data-slot="composer-model-fast"]')).toBeNull()
  })

  it('aligns the control below Thinking and uses the existing desktop hover tooltip', async () => {
    await renderMenu({ initial: true })
    const row = document.querySelector<HTMLElement>('[data-slot="composer-model-fast"]')!
    const thinking = row.previousElementSibling!
    const rowBox = row.getBoundingClientRect(), thinkingBox = thinking.getBoundingClientRect()
    const switchBox = fast()!.getBoundingClientRect()
    expect(row.firstElementChild?.textContent).toBe('Fast')
    expect(thinking.textContent).toContain('Thinking')
    expect(rowBox.height).toBe(thinkingBox.height)
    expect(row.firstElementChild!.getBoundingClientRect().x).toBe(thinking.firstElementChild!.getBoundingClientRect().x)
    expect(switchBox.right).toBe(thinking.lastElementChild!.getBoundingClientRect().right)
    expect(Math.abs(rowBox.y + rowBox.height / 2 - switchBox.y - switchBox.height / 2)).toBeLessThan(1)
    await detailSwitch().hover()
    await expect.element(page.getByText('Faster, uses more quota', { exact: true })).toBeVisible()
  })

  it('keeps the same phone toggle without tooltip text', async () => {
    await page.viewport(390, 844)
    container.style.cssText = 'width:366px;position:absolute;left:12px;bottom:24px'
    await renderMenu({ mobile: true })
    expect(fast()!.getBoundingClientRect().height).toBe(44)
    expect(fast()!.firstElementChild!.getBoundingClientRect().height).toBe(32)
    expect(getComputedStyle(fast()!.firstElementChild!).fontSize).toBe('13px')
    expect(fast()!.querySelector('svg')!.getBoundingClientRect().width).toBe(14)
    await page.getByRole('button', { name: 'Fast', exact: true }).hover()
    expect(fast()?.hasAttribute('aria-describedby')).toBe(false)
    expect(document.querySelector('[role="tooltip"]')).toBeNull()
    const focused = document.activeElement
    await page.getByRole('button', { name: 'Fast', exact: true }).click()
    await until('phone Fast accepted', () => fast()?.getAttribute('aria-pressed') === 'true')
    expect(document.activeElement).toBe(focused)
    expect(changed).toHaveBeenCalledExactlyOnceWith(true)
    expect(document.body.textContent).not.toContain('Faster, uses more quota')
  })

  it('keeps the tooltip in a compact desktop conversation', async () => {
    await renderMenu({ mobile: true, phoneActions: false })
    await detailSwitch().hover()
    await expect.element(page.getByText('Faster, uses more quota', { exact: true })).toBeVisible()
  })
})
