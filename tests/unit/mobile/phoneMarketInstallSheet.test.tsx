// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { PhoneMarketInstallSheet } from '../../../apps/desktop/src/mobile/market/PhoneMarketInstallSheet'
import { clickElement, createReactHarness, deferred, waitForCondition } from '../../support/testHarness'

let harness: ReturnType<typeof createReactHarness>
beforeEach(() => { harness = createReactHarness() })
afterEach(() => harness.cleanup())

const button = (id: string) => document.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`)!

it('installs on only the computers selected in the sheet and retries only failed targets', async () => {
  const pending = deferred<boolean>()
  const installA = vi.fn(() => pending.promise)
  const installB = vi.fn<() => Promise<boolean>>().mockResolvedValueOnce(false).mockResolvedValueOnce(true)
  const untouched = vi.fn(async () => true)
  const close = vi.fn()
  await harness.render(<PhoneMarketInstallSheet onClose={close} rows={[
    { id: 'one', name: 'First', install: installA },
    { id: 'two', name: 'Second', status: 'update', install: installB },
    { id: 'three', name: 'Other', install: untouched },
    { id: 'offline', name: 'Offline', status: 'offline' },
    { id: 'present', name: 'Installed', status: 'installed' },
  ]} />)
  const submit = button('phone-market-install-confirm')
  expect(submit.disabled).toBe(true)
  expect(button('phone-market-install-device-offline').disabled).toBe(true)
  expect(button('phone-market-install-device-present').getAttribute('aria-checked')).toBe('true')
  await clickElement(button('phone-market-install-device-one'))
  await clickElement(button('phone-market-install-device-two'))
  await clickElement(submit)
  expect(installA).toHaveBeenCalledTimes(1)
  expect(installB).toHaveBeenCalledTimes(0)
  expect(submit.disabled).toBe(true)
  await act(async () => { pending.resolve(true) })
  await waitForCondition(() => !submit.disabled, 'Retry enabled once both installation attempts settle')
  expect(installB).toHaveBeenCalledTimes(1)
  expect(close).not.toHaveBeenCalled()
  await clickElement(submit)
  expect(installA).toHaveBeenCalledTimes(1)
  expect(installB).toHaveBeenCalledTimes(2)
  expect(untouched).not.toHaveBeenCalled()
  expect(close).toHaveBeenCalledTimes(1)
})
