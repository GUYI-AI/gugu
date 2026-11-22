import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { createReactHarness } from '../../../../../../../tests/support/testHarness'
import { GeneralSection } from '@/components/settings/GeneralSection'
import { LocalizationProvider, i18n } from '@/i18n'
import { ThemeProvider } from '@/store/theme'
import { readDevicePreferences, writeDevicePreferences } from '@/lib/devicePreferences'
import type { SystemPermission, SystemPermissionState } from '@/platform/types'
import '@/i18n/registerMainCatalog'

const native = vi.hoisted(() => ({
  supported: true,
  battery: vi.fn<() => Promise<SystemPermissionState>>(),
  deviceInfo: vi.fn(async () => ({ brand: 'OnePlus', manufacturer: 'OnePlus' })),
}))
import { followRendererSession, queryClient } from '@/lib/replica'
vi.mock('@/platform', async original => {
  const actual = await original<typeof import('@/platform')>()
  return {
    ...actual,
    platform: {
      ...actual.platform,
      kind: 'capacitor',
      capabilities: { ...actual.platform.capabilities, notifications: true },
      get systemPermissions() { return native.supported ? ['notifications', 'batteryOptimization'] : ['notifications'] },
      checkSystemPermission: (permission: SystemPermission) => permission === 'batteryOptimization'
        ? native.battery() : Promise.resolve('granted'),
    },
  }
})
vi.mock('@/mobile/phone-device/nativePhoneActions', async original => {
  const actual = await original<typeof import('@/mobile/phone-device/nativePhoneActions')>()
  return { ...actual, nativePhoneActions: { ...actual.nativePhoneActions, deviceInfo: native.deviceInfo } }
})
vi.mock('@gugu/core/cloud/config', async original => ({
  ...(await original<object>()),
  getSupabaseUrl: () => 'http://supabase.test.local',
  getSupabaseAnonKey: () => 'test-anon-key',
}))

const marker = 'gugu.android.chat-notifications.battery-guidance-v1'
let harness: ReturnType<typeof createReactHarness> | undefined
const guidance = () => page.getByRole('button', { name: 'Allow background messages', exact: true })
async function openSettings() {
  harness = createReactHarness()
  await harness.render(<LocalizationProvider><ThemeProvider><GeneralSection onOpenPermissions={() => {}} /></ThemeProvider></LocalizationProvider>)
}
beforeEach(async () => {
  // The phone's maker is the account replica `phoneInstallation`: read for whoever is signed in.
  followRendererSession('SIGNED_IN', 'reader')
  await page.viewport(390, 844)
  await i18n.changeLanguage('en-US')
  localStorage.removeItem(marker)
  writeDevicePreferences({ chatMessages: true })
  native.supported = true
  native.battery.mockReset().mockResolvedValue('prompt')
  native.deviceInfo.mockClear()
})
afterEach(() => {
  harness?.cleanup()
  harness = undefined
  // Each case reads the permission and the installation afresh.
  queryClient.clear()
  localStorage.removeItem(marker)
  writeDevicePreferences({ chatMessages: true })
})

it('shows once on entry with notifications already enabled and keeps the marker across remounts', async () => {
  await openSettings()
  await expect.element(guidance()).toBeVisible()
  expect(readDevicePreferences().chatMessages).toBe(true)
  expect(localStorage.getItem(marker)).toBe('shown')
  harness!.cleanup()
  harness = undefined
  await openSettings()
  await expect.element(guidance()).not.toBeInTheDocument()
  expect(native.battery).toHaveBeenCalledTimes(1)
})

it('waits for explicitly enabling notifications when they were disabled', async () => {
  writeDevicePreferences({ chatMessages: false })
  await openSettings()
  await expect.element(guidance()).not.toBeInTheDocument()
  expect(native.battery).not.toHaveBeenCalled()
  await page.getByRole('switch', { name: 'Enable chat message notifications', exact: true }).click()
  await expect.element(guidance()).toBeVisible()
})

it('preserves an existing shown marker on upgrade and after disabling and re-enabling notifications', async () => {
  localStorage.setItem(marker, 'shown')
  await openSettings()
  await expect.element(guidance()).not.toBeInTheDocument()
  const toggle = page.getByRole('switch', { name: 'Enable chat message notifications', exact: true })
  await toggle.click()
  await toggle.click()
  await expect.element(guidance()).not.toBeInTheDocument()
  expect(native.battery).not.toHaveBeenCalled()
  expect(localStorage.getItem(marker)).toBe('shown')
})

it('does not repeat guidance after showing it and disabling and re-enabling notifications', async () => {
  await openSettings()
  await expect.element(guidance()).toBeVisible()
  const toggle = page.getByRole('switch', { name: 'Enable chat message notifications', exact: true })
  await toggle.click()
  await toggle.click()
  await expect.element(guidance()).not.toBeInTheDocument()
  expect(native.battery).toHaveBeenCalledTimes(1)
})

it.each(['granted', 'blocked', 'unreadable'] as const)('does not consume the marker for battery state %s', async state => {
  native.battery.mockResolvedValue(state)
  await openSettings()
  expect(native.battery).toHaveBeenCalled()
  await expect.element(guidance()).not.toBeInTheDocument()
  expect(localStorage.getItem(marker)).toBeNull()
})

it('does not check battery optimization on unsupported hosts', async () => {
  native.supported = false
  await openSettings()
  expect(native.battery).not.toHaveBeenCalled()
  expect(localStorage.getItem(marker)).toBeNull()
})

it('does not mark guidance as shown after leaving settings during the permission check', async () => {
  let finish!: (state: SystemPermissionState) => void
  native.battery.mockImplementationOnce(() => new Promise<SystemPermissionState>(resolve => { finish = resolve }))
  await openSettings()
  harness!.cleanup()
  harness = undefined
  await act(async () => { finish('prompt') })
  expect(localStorage.getItem(marker)).toBeNull()
  await openSettings()
  await expect.element(guidance()).toBeVisible()
})

it('does not show or consume guidance if notifications turn off during the permission check', async () => {
  let finish!: (state: SystemPermissionState) => void
  native.battery.mockImplementationOnce(() => new Promise<SystemPermissionState>(resolve => { finish = resolve }))
  await openSettings()
  await page.getByRole('switch', { name: 'Enable chat message notifications', exact: true }).click()
  await act(async () => { finish('prompt') })
  expect(readDevicePreferences().chatMessages).toBe(false)
  await expect.element(guidance()).not.toBeInTheDocument()
  expect(localStorage.getItem(marker)).toBeNull()
})
