// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clickElement, createNode, createReactHarness, deferred } from '../../../support/testHarness'

const native = vi.hoisted(() => ({ foreground: null as (() => void) | null, failed: null as ((error: unknown) => void) | null, unsubscribe: vi.fn() }))
vi.mock('../../../../apps/desktop/src/platform', () => ({ platform: {
  subscribeAppForeground: (listener: () => void, failed: (error: unknown) => void) => {
    native.foreground = listener; native.failed = failed; return native.unsubscribe
  },
} }))

import { IOSCalendarPermissionsPanel } from '../../../../apps/desktop/src/mobile/ios-calendar/IOSCalendarPermissionsPanel'
import type { IOSCalendarPermissionStatus } from '../../../../apps/desktop/src/mobile/ios-calendar/iosCalendarPermissions'

function status(authorization: IOSCalendarPermissionStatus['authorization']): IOSCalendarPermissionStatus {
  return { authorization, os_readable: authorization === 'fullAccess', os_writable: authorization === 'fullAccess' || authorization === 'writeOnly' }
}
let harness: ReturnType<typeof createReactHarness>
beforeEach(() => { vi.clearAllMocks(); native.foreground = null; native.failed = null; harness = createReactHarness() })
afterEach(() => harness.cleanup())

const permissionText = () => harness.container.querySelector('[role="status"]')?.textContent
const reload = () => harness.container.querySelector<HTMLButtonElement>('button[aria-label="重新读取日历权限"]')!

describe('iOS calendar permission panel', () => {
  it('shows actual full OS access without claiming the agent category is connected', async () => {
    const readStatus = vi.fn(async () => status('fullAccess'))
    await harness.render(createNode(IOSCalendarPermissionsPanel, { ownerId: 'owner-a', readStatus }))
    expect(permissionText()).toBe('系统已允许')
    expect(harness.container.textContent).not.toContain('已开启')
    expect(readStatus).toHaveBeenCalledOnce()
    expect(Array.from(harness.container.querySelectorAll('button')).map(button => button.textContent)).toEqual(['重新读取'])
  })

  it('keeps write-only access distinct from full access', async () => {
    await harness.render(createNode(IOSCalendarPermissionsPanel, { ownerId: 'owner-a', readStatus: async () => status('writeOnly') }))
    expect(permissionText()).toBe('仅允许写入')
    expect(harness.container.textContent).toContain('读取和管理日程需要完整日历权限。')
  })

  it('shows a native read failure and retries the real status reader', async () => {
    const readStatus = vi.fn().mockRejectedValueOnce(new Error('未读到日历权限')).mockResolvedValueOnce(status('denied'))
    await harness.render(createNode(IOSCalendarPermissionsPanel, { ownerId: 'owner-a', readStatus }))
    expect(permissionText()).toBe('查不到')
    expect(harness.container.querySelector('[role="alert"]')?.textContent).toBe('未读到日历权限，请重新读取。')
    await clickElement(reload())
    expect(permissionText()).toBe('未授权')
    expect(harness.container.querySelector('[role="alert"]')).toBeNull()
    expect(readStatus).toHaveBeenCalledTimes(2)
  })

  it('drops a prior granted state while foreground refresh checks revocation', async () => {
    const revoked = deferred<IOSCalendarPermissionStatus>()
    const readStatus = vi.fn().mockResolvedValueOnce(status('fullAccess')).mockReturnValueOnce(revoked.promise)
    await harness.render(createNode(IOSCalendarPermissionsPanel, { ownerId: 'owner-a', readStatus }))
    await act(async () => native.foreground?.())
    expect(permissionText()).toBe('正在读取')
    expect(reload().disabled).toBe(true)
    await act(async () => revoked.resolve(status('denied')))
    expect(permissionText()).toBe('未授权')
    expect(readStatus).toHaveBeenCalledTimes(2)
  })

  it('does not let a late granted read overwrite a newer denied read', async () => {
    const oldRead = deferred<IOSCalendarPermissionStatus>()
    const readStatus = vi.fn().mockReturnValueOnce(oldRead.promise).mockResolvedValueOnce(status('denied'))
    await harness.render(createNode(IOSCalendarPermissionsPanel, { ownerId: 'owner-a', readStatus }))
    await act(async () => native.foreground?.())
    expect(permissionText()).toBe('未授权')
    await act(async () => oldRead.resolve(status('fullAccess')))
    expect(permissionText()).toBe('未授权')
  })

  it('withholds an old owner response after the page changes owner', async () => {
    const oldRead = deferred<IOSCalendarPermissionStatus>()
    const readStatus = vi.fn().mockReturnValueOnce(oldRead.promise).mockResolvedValueOnce(status('restricted'))
    await harness.render(createNode(IOSCalendarPermissionsPanel, { ownerId: 'owner-a', readStatus }))
    await harness.render(createNode(IOSCalendarPermissionsPanel, { ownerId: 'owner-b', readStatus }))
    await act(async () => oldRead.resolve(status('fullAccess')))
    expect(permissionText()).toBe('系统限制')
    expect(native.unsubscribe).toHaveBeenCalledOnce()
  })

  it('renders a native stale binding as an error without exposing its internal message', async () => {
    const readStatus = vi.fn().mockRejectedValue({ code: 'stale_context', message: 'Internal owner/install mismatch' })
    await harness.render(createNode(IOSCalendarPermissionsPanel, { ownerId: 'owner-a', readStatus }))
    expect(permissionText()).toBe('查不到')
    expect(harness.container.querySelector('[role="alert"]')?.textContent).toBe('账号或这台手机的身份已变化，请重新打开权限页。')
  })

  it('withholds a pending allowed result when the native foreground observer fails', async () => {
    const oldRead = deferred<IOSCalendarPermissionStatus>()
    await harness.render(createNode(IOSCalendarPermissionsPanel, { ownerId: 'owner-a', readStatus: () => oldRead.promise }))
    await act(async () => native.failed?.(new Error('Native lifecycle listener failed')))
    await act(async () => oldRead.resolve(status('fullAccess')))
    expect(permissionText()).toBe('查不到')
    expect(harness.container.querySelector('[role="alert"]')?.textContent).toBe('未读到日历权限，请重新读取。')
  })

  it('shows native owner refusal without retrying or exposing permission actions', async () => {
    const readStatus = vi.fn().mockRejectedValue({ code: 'not_granted', message: 'Native owner guard refused' })
    await harness.render(createNode(IOSCalendarPermissionsPanel, { ownerId: 'owner-a', readStatus }))
    expect(permissionText()).toBe('查不到')
    expect(harness.container.querySelector('[role="alert"]')?.textContent).toBe('请在当前账号的权限页查看日历权限。')
    expect(readStatus).toHaveBeenCalledOnce()
  })
})
