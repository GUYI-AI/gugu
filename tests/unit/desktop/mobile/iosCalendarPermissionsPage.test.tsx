// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clickElement, createNode, createReactHarness, deferred } from '../../../support/testHarness'
import type { IOSOwnerPublicationState } from '../../../../apps/desktop/src/mobile/ios-runtime/iosOwnerPublication'

const native = vi.hoisted(() => ({ isNative: true, platform: 'ios', plugins: new Set<string>(),
  publication: {} as unknown, listeners: new Set<() => void>(), foreground: new Set<() => void>(),
  retry: vi.fn(), status: vi.fn(), connect: vi.fn(), disconnect: vi.fn(), unsubscribe: vi.fn() }))
vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => native.isNative, getPlatform: () => native.platform,
    isPluginAvailable: (name: string) => native.plugins.has(name) },
  registerPlugin: (name: string) => {
    if (name !== 'GuguCalendarPermissions') throw new Error(`Unexpected plugin ${name}`)
    return { status: native.status, connect: native.connect, disconnect: native.disconnect }
  },
}))
vi.mock('../../../../apps/desktop/src/mobile/ios-runtime/startIOSOwnerPublication', () => ({
  getIOSOwnerPublicationSnapshot: () => native.publication,
  subscribeIOSOwnerPublication: (listener: () => void) => { native.listeners.add(listener); return () => native.listeners.delete(listener) },
  retryIOSOwnerPublication: () => native.retry(),
}))
vi.mock('../../../../apps/desktop/src/platform', () => ({ platform: {
  subscribeAppForeground: (listener: () => void) => {
    native.foreground.add(listener)
    return () => { native.foreground.delete(listener); native.unsubscribe() }
  },
} }))

import { IOSCalendarPermissionsPage } from '../../../../apps/desktop/src/mobile/ios-calendar/IOSCalendarPermissionsPage'
import { iosCalendarPermissionsAvailable } from '../../../../apps/desktop/src/mobile/ios-calendar/iosCalendarPermissionsAvailability'

const A = '10000000-0000-0000-0000-000000000001', B = '20000000-0000-0000-0000-000000000002'
const installationId = '30000000-0000-0000-0000-000000000003'
const binding = (ownerId = A) => ({ ownerId, installationId, deviceId: `phone-${installationId}-${ownerId}` })
const ready = (ownerId = A): IOSOwnerPublicationState => ({ status: 'ready', binding: binding(ownerId), error: null })
const pending = (status: 'unavailable' | 'waiting' | 'publishing' | 'retiring' | 'stopped'): IOSOwnerPublicationState => ({ status, binding: null, error: null })
const failed = (): IOSOwnerPublicationState => ({ status: 'failed', binding: null, error: { code: 'retirement_failed', message: 'internal synthetic-access-secret' } })
const calendar = (ownerId = A, connected = true) => ({ authorization: 'fullAccess', os_readable: true, os_writable: true,
  binding: binding(ownerId), calendarConnected: connected, calendarRevision: installationId })
let harness: ReturnType<typeof createReactHarness>
const render = (ownerId: string | null = A) => harness.render(createNode(IOSCalendarPermissionsPage, { ownerId }))
const retryButton = () => harness.container.querySelector<HTMLButtonElement>('button[aria-label="重新核验本机身份"]')
const calendarButton = () => Array.from(harness.container.querySelectorAll('button')).find(button => button.textContent === '连接日历' || button.textContent === '断开日历')
const publish = async (state: IOSOwnerPublicationState) => act(async () => { native.publication = state; native.listeners.forEach(listener => listener()) })
beforeEach(() => {
  vi.clearAllMocks(); native.isNative = true; native.platform = 'ios'; native.plugins = new Set(['GuguCalendarPermissions', 'GuguIOSOwner'])
  native.publication = pending('waiting'); native.listeners.clear(); native.foreground.clear()
  native.retry.mockReset().mockResolvedValue(undefined)
  native.status.mockReset().mockImplementation(async ({ ownerId }: { ownerId: string }) => calendar(ownerId))
  harness = createReactHarness()
})
afterEach(() => harness.cleanup())

describe('iOS-only calendar navigation availability', () => {
  it.each(['not-native', 'web', 'android', 'missing-calendar', 'missing-owner', 'both-present'])('uses actual native platform and registration: %s', async target => {
    native.isNative = target !== 'not-native'
    native.platform = target === 'web' || target === 'android' ? target : 'ios'
    if (target === 'missing-calendar') native.plugins.delete('GuguCalendarPermissions')
    if (target === 'missing-owner') native.plugins.delete('GuguIOSOwner')
    expect(iosCalendarPermissionsAvailable()).toBe(target === 'both-present')
    expect(native.status).not.toHaveBeenCalled(); expect(native.connect).not.toHaveBeenCalled()
    native.publication = ready(); await render()
    if (target !== 'both-present') {
      expect(calendarButton()).toBeUndefined(); expect(retryButton()).toBeNull()
      expect(native.status).not.toHaveBeenCalled()
      expect(harness.container.textContent).toContain('此安装包暂未提供本机日历权限。')
    }
  })
})

describe('iOS calendar page owner gate', () => {
  it('mounts the real calendar panel only for ready/current owner, without prompting', async () => {
    native.publication = ready(); await render()
    expect(calendarButton()?.textContent).toBe('断开日历')
    expect(native.status).toHaveBeenCalledExactlyOnceWith({ ownerId: A })
    expect(native.connect).not.toHaveBeenCalled(); expect(native.retry).not.toHaveBeenCalled()
  })

  it('withholds a ready binding belonging to another owner', async () => {
    native.publication = ready(B); await render()
    expect(harness.container.textContent).toContain('账号已变化')
    expect(calendarButton()).toBeUndefined(); expect(native.status).not.toHaveBeenCalled()
    await clickElement(retryButton()!)
    expect(native.retry).toHaveBeenCalledOnce()
  })

  it.each([null, ''])('withholds native permission actions without a current user: %s', async ownerId => {
    native.publication = ready(); await render(ownerId)
    expect(harness.container.textContent).toContain('请先登录')
    expect(calendarButton()).toBeUndefined(); expect(retryButton()).toBeNull()
    expect(native.status).not.toHaveBeenCalled()
  })

  it.each(['waiting', 'publishing', 'retiring', 'unavailable'] as const)('shows actual %s state and offers publication retry without calendar access', async status => {
    native.publication = pending(status); await render()
    expect(calendarButton()).toBeUndefined(); expect(native.status).not.toHaveBeenCalled()
    await clickElement(retryButton()!)
    expect(native.retry).toHaveBeenCalledOnce()
    expect(native.connect).not.toHaveBeenCalled()
  })

  it('renders a failed native publication with safe copy and an explicit retry', async () => {
    native.publication = failed(); await render()
    expect(harness.container.querySelector('[role="alert"]')?.textContent).toBe('上一轮本机连接还未结束，请重试。')
    expect(harness.container.textContent).not.toContain('synthetic-access-secret')
    await clickElement(retryButton()!)
    expect(native.retry).toHaveBeenCalledOnce()
  })

  it.each(['failed', 'stopped'] as const)('unmounts pending calendar reads immediately on %s and discards the late allowed reply', async status => {
    const old = deferred<ReturnType<typeof calendar>>()
    native.status.mockReturnValueOnce(old.promise)
    native.publication = ready(); await render()
    expect(native.foreground.size).toBe(1)
    await publish(status === 'failed' ? failed() : pending('stopped'))
    expect(native.foreground.size).toBe(0); expect(native.unsubscribe).toHaveBeenCalledOnce()
    await act(async () => old.resolve(calendar()))
    expect(calendarButton()).toBeUndefined()
    expect(harness.container.textContent).not.toContain('已连接')
    if (status === 'stopped') { expect(retryButton()).toBeNull(); expect(harness.container.textContent).toContain('已停止') }
  })

  it('unmounts the old owner before the new binding arrives and never shows an old read on the new owner', async () => {
    const old = deferred<ReturnType<typeof calendar>>()
    native.status.mockReturnValueOnce(old.promise).mockResolvedValueOnce(calendar(B, false))
    native.publication = ready(); await render()
    await render(B)
    expect(native.foreground.size).toBe(0); expect(calendarButton()).toBeUndefined()
    await publish(ready(B))
    expect(native.status).toHaveBeenLastCalledWith({ ownerId: B })
    await act(async () => old.resolve(calendar()))
    expect(calendarButton()?.textContent).toBe('连接日历')
    expect(harness.container.textContent).not.toContain('已连接')
  })

  it('mounts the calendar only when a pending publication becomes ready', async () => {
    await render(); expect(native.status).not.toHaveBeenCalled()
    await publish(ready())
    expect(native.status).toHaveBeenCalledOnce(); expect(calendarButton()).toBeDefined()
    await publish(pending('publishing'))
    expect(native.foreground.size).toBe(0); expect(calendarButton()).toBeUndefined()
  })

  it('unmounts calendar controls if either native registration disappears', async () => {
    native.publication = ready(); await render()
    native.plugins.delete('GuguIOSOwner'); await render()
    expect(native.foreground.size).toBe(0); expect(calendarButton()).toBeUndefined()
  })

  it('coalesces rapid retries and drops an old account retry rejection', async () => {
    const old = deferred<void>()
    native.retry.mockReturnValueOnce(old.promise)
    native.publication = failed(); await render()
    const button = retryButton()!
    await act(async () => { button.click(); button.click() })
    expect(native.retry).toHaveBeenCalledOnce(); expect(retryButton()?.disabled).toBe(true)
    await render(B); await publish(ready(B))
    await act(async () => old.reject(new Error('old-owner-secret')))
    expect(calendarButton()).toBeDefined()
    expect(harness.container.textContent).not.toContain('old-owner-secret')
    expect(harness.container.querySelector('[role="alert"]')).toBeNull()
  })

  it('makes an unexpected retry rejection visible without leaking internal errors', async () => {
    native.retry.mockRejectedValueOnce(new Error('synthetic-access-secret'))
    await render(); await clickElement(retryButton()!)
    expect(harness.container.querySelector('[role="alert"]')?.textContent).toBe('未能重新核验本机身份，请重试。')
    expect(retryButton()?.disabled).toBe(false)
    expect(harness.container.textContent).not.toContain('synthetic-access-secret')
  })
})
