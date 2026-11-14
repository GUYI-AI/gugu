import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { billingLinksAvailable, GUGU_BILLING_URL, openBillingPage } from '../../../../apps/desktop/src/lib/appLinks'

const runtime = vi.hoisted(() => ({ native: false, platform: 'web' }))
vi.mock('@capacitor/core', () => ({ Capacitor: {
  isNativePlatform: () => runtime.native,
  getPlatform: () => runtime.platform,
} }))

describe('iOS account purchase links', () => {
  const open = vi.fn()
  beforeEach(() => {
    runtime.native = false; runtime.platform = 'web'; open.mockReset()
    vi.stubGlobal('window', { open })
  })
  afterEach(() => vi.unstubAllGlobals())

  it('blocks the browser command in the native iOS package', () => {
    runtime.native = true; runtime.platform = 'ios'
    expect(billingLinksAvailable()).toBe(false)
    openBillingPage()
    expect(open).not.toHaveBeenCalled()
  })

  it.each([[true, 'android'], [false, 'web'], [false, 'ios']])(
    'retains the existing external account destination when native=%s and platform=%s', (native, platform) => {
      runtime.native = native as boolean; runtime.platform = platform as string
      expect(billingLinksAvailable()).toBe(true)
      openBillingPage()
      expect(open).toHaveBeenCalledExactlyOnceWith(GUGU_BILLING_URL, '_blank', 'noopener,noreferrer')
    },
  )

  it('rechecks the platform when an earlier navigation handler is invoked', () => {
    const priorHandler = openBillingPage
    runtime.native = true; runtime.platform = 'ios'
    priorHandler()
    expect(open).not.toHaveBeenCalled()
  })
})
