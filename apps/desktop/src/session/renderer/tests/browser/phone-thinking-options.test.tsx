import { useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { MessageProvider } from '@gugu/session-ui/react/components'
import { LocalizationProvider } from '@/i18n'
import { translateSessionMessage } from '@renderer/localization/locale-store'
import { PhoneThinkingOptions } from '@/mobile/composer/PhoneThinkingOptions'
import '@/mobile/agent-watch/create-controls-catalog'
import '@/styles/tokens.css'

let root: Root | null = null, host: HTMLDivElement | null = null
const changed = vi.fn(), fastChanged = vi.fn()
let acceptFast: (value: boolean) => void = () => undefined
function Fixture({ empty = false }: { empty?: boolean }) {
  const [level, setLevel] = useState('vendor-level'), [fast, setFast] = useState(false)
  acceptFast = setFast
  return <PhoneThinkingOptions effortOptions={empty ? {} : {
    'vendor-level': { name: 'Native level' }, max: { name: 'Maximum' }, blocked: { name: 'Blocked', disabled: true, disabledReason: 'Unavailable now' },
  }} selectedEffort={level} onEffortChange={id => { changed(id); setLevel(id) }} fastMode={fast} onFastModeChange={fastChanged} />
}
afterEach(() => { root?.unmount(); host?.remove(); root = null; host = null; changed.mockClear(); fastChanged.mockClear() })
async function mount(empty = false) {
  await page.viewport(320, 640)
  host = document.body.appendChild(document.createElement('div')); root = createRoot(host)
  root.render(<LocalizationProvider><MessageProvider locale="zh-CN" translate={translateSessionMessage}><Fixture empty={empty} /></MessageProvider></LocalizationProvider>)
  await expect.element(page.getByTestId('phone-thinking-options')).toBeVisible()
}
it('uses text choices with the real native IDs and blocks unavailable values', async () => {
  await mount()
  expect(host!.querySelector('input[type="range"]')).toBeNull()
  expect(host!.querySelectorAll('[role="radio"]')).toHaveLength(3)
  await expect.element(page.getByRole('radio', { name: 'Native level' })).toHaveAttribute('aria-checked', 'true')
  await page.getByRole('radio', { name: 'Maximum' }).click()
  expect(changed).toHaveBeenCalledExactlyOnceWith('max')
  await expect.element(page.getByRole('radio', { name: 'Blocked' })).toBeDisabled()
  expect(fastChanged).not.toHaveBeenCalled()
})
it('renders Fast without reasoning levels and waits for externally accepted state', async () => {
  await mount(true)
  expect(host!.querySelector('[role="radiogroup"]')).toBeNull()
  const button = host!.querySelector<HTMLButtonElement>('[data-fast-mode-toggle]')!
  await page.elementLocator(button).click()
  expect(fastChanged).toHaveBeenCalledExactlyOnceWith(true)
  expect(button.getAttribute('aria-pressed')).toBe('false')
  acceptFast(true)
  await expect.element(page.elementLocator(button)).toHaveAttribute('aria-pressed', 'true')
  expect(changed).not.toHaveBeenCalled()
})
