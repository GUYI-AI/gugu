// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { PhoneMarketInstallSheet } from '../../../apps/desktop/src/mobile/market/PhoneMarketInstallSheet'
import { runPhoneAgentInstall } from '../../../apps/desktop/src/mobile/market/phoneAgentInstall'
import { i18n } from '../../../apps/desktop/src/i18n/runtime'
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

it('keeps the remote update cause and records the stage the host reached', async () => {
  const stop = vi.fn()
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  try {
    const update = vi.fn()
      .mockResolvedValueOnce({ success: false, error: {
        type: 'command-failed', message: 'Managed installation failed.', output: 'EACCES writing the package',
        stage: 'download', lastProgress: { phase: 'installing', elapsedMs: 50 },
      } })
      .mockResolvedValueOnce({ success: true })
    const close = vi.fn()
    await harness.render(<PhoneMarketInstallSheet onClose={close} rows={[{
      id: 'test-host', name: 'Test host', status: 'update',
      install: () => runPhoneAgentInstall({ install: vi.fn(), update, onInstallProgress: listener => {
        listener({ providerId: 'dsh', phase: 'installing', elapsedMs: 50 })
        return stop
      } }, 'test-host', 'dsh', { kind: 'update', method: 'mise' }),
    }]} />)
    await clickElement(button('phone-market-install-device-test-host'))
    await clickElement(button('phone-market-install-confirm'))
    await waitForCondition(() => !!document.querySelector('[role="alert"]'), 'Host failure is visible')
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('EACCES writing the package')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Host did not complete agent operation'), expect.objectContaining({
      agentId: 'dsh', operation: 'update', stage: 'host', hostStage: 'download', phase: 'installing',
      lastProgress: { phase: 'installing', elapsedMs: 50 },
    }))
    expect(close).not.toHaveBeenCalled()
    expect(button('phone-market-install-confirm').textContent).toBe(i18n.t('phoneMarket.retry', { ns: 'main' }))
    await clickElement(button('phone-market-install-confirm'))
    expect(update).toHaveBeenCalledTimes(2)
    expect(stop).toHaveBeenCalledTimes(2)
    expect(close).toHaveBeenCalledTimes(1)
  } finally {
    warn.mockRestore()
  }
})
