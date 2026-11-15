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
const fast = () => document.querySelector<HTMLButtonElement>('button[aria-label="Fast"]')

function Fixture({ supported = true, mobile = false, initial = false, phoneActions = mobile }) {
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
  await until('thinking slider mounted', () => document.querySelector('[data-slot="composer-effort-indicator"]') != null)
  const panel = document.querySelector<HTMLElement>('[data-slot="combobox-content"]')!
  await until('model menu entered', () => !panel.hasAttribute('data-starting-style'))
  await Promise.all(panel.getAnimations().map(animation => animation.finished))
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
    expect(fast()?.getAttribute('aria-pressed')).toBe('false')
    expect(fast()?.querySelector('svg')?.getAttribute('fill')).toBe('none')
    await page.getByRole('button', { name: 'Fast', exact: true }).click()
    await until('Fast accepted', () => fast()?.getAttribute('aria-pressed') === 'true')
    expect(changed.mock.calls).toEqual([[true]])
    expect(fast()?.querySelector('svg')?.getAttribute('fill')).toBe('currentColor')
    await page.getByRole('button', { name: 'Fast', exact: true }).click()
    await until('Fast switched off', () => fast()?.getAttribute('aria-pressed') === 'false')
    expect(changed.mock.calls).toEqual([[true], [false]])
    expect(effortChanged).not.toHaveBeenCalled()
    expect(modelChanged).not.toHaveBeenCalled()
    expect(container.querySelector('button[aria-label="Fast"]')).toBeNull()
  })

  it('renders no Fast control or reserved slider space for an unsupported model', async () => {
    await renderMenu({ supported: false })
    expect(fast()).toBeNull()
    expect(document.querySelector('[data-fast-mode]')).toBeNull()
  })

  it('aligns the icon with the slider and uses the existing desktop hover tooltip', async () => {
    await renderMenu({ initial: true })
    const track = document.querySelector<HTMLElement>('[data-slot="composer-effort-indicator"]')!.parentElement!
    const trackBox = track.getBoundingClientRect(), buttonBox = fast()!.getBoundingClientRect()
    expect(Math.abs(trackBox.y + trackBox.height / 2 - buttonBox.y - buttonBox.height / 2)).toBeLessThan(1)
    expect(Math.abs(buttonBox.x - trackBox.right - 8)).toBeLessThan(0.5)
    expect(buttonBox.height).toBe(24)
    expect(fast()!.firstElementChild!.getBoundingClientRect().height).toBe(24)
    expect(getComputedStyle(fast()!.firstElementChild!).fontSize).toBe('12px')
    expect(fast()!.querySelector('svg')!.getBoundingClientRect().width).toBe(12)
    await page.getByRole('button', { name: 'Fast', exact: true }).hover()
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
    await page.getByRole('button', { name: 'Fast', exact: true }).hover()
    await expect.element(page.getByText('Faster, uses more quota', { exact: true })).toBeVisible()
  })
})
