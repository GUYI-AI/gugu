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
import type { IOSCalendarPermissionClient, IOSCalendarPermissionStatus, IOSCalendarSnapshot } from '../../../../apps/desktop/src/mobile/ios-calendar/iosCalendarPermissions'

const binding = { ownerId: 'owner-a', deviceId: 'device-a', installationId: 'installation-a' }
function status(authorization: IOSCalendarPermissionStatus['authorization'], connected = false, ownerId = 'owner-a'): IOSCalendarSnapshot {
  return { authorization, os_readable: authorization === 'fullAccess', os_writable: authorization === 'fullAccess' || authorization === 'writeOnly',
    binding: { ...binding, ownerId }, calendarConnected: connected, calendarRevision: connected ? 'native-revision' : null }
}
function client(read = vi.fn(async () => status('fullAccess'))): IOSCalendarPermissionClient {
  return { read, connect: vi.fn(async () => status('fullAccess', true)), disconnect: vi.fn(async () => status('fullAccess')) }
}
let harness: ReturnType<typeof createReactHarness>
beforeEach(() => { vi.clearAllMocks(); native.foreground = null; native.failed = null; harness = createReactHarness() })
afterEach(() => harness.cleanup())

const permissionText = () => harness.container.querySelector('[role="status"]')?.textContent
const reload = () => harness.container.querySelector<HTMLButtonElement>('button[aria-label="重新读取日历权限"]')!
const action = () => Array.from(harness.container.querySelectorAll<HTMLButtonElement>('button')).find(button => button.textContent === '连接日历' || button.textContent === '断开日历')!
const render = (transport: IOSCalendarPermissionClient, ownerId = 'owner-a') => harness.render(createNode(IOSCalendarPermissionsPanel, { ownerId, client: transport }))

describe('iOS calendar permission panel', () => {
  it('shows full OS access separately from the unconnected native category and never prompts on discovery', async () => {
    const transport = client()
    await render(transport)
    expect(permissionText()).toBe('未连接 · 系统已允许')
    expect(action().textContent).toBe('连接日历')
    expect(transport.read).toHaveBeenCalledExactlyOnceWith('owner-a')
    expect(transport.connect).not.toHaveBeenCalled()
  })

  it('keeps write-only access distinct from full access', async () => {
    await render(client(vi.fn(async () => status('writeOnly'))))
    expect(permissionText()).toBe('未连接 · 仅允许写入')
    expect(harness.container.textContent).toContain('读取和管理日程需要完整日历权限。')
  })

  it('shows a native read failure and retries only the status reader', async () => {
    const transport = client(vi.fn().mockRejectedValueOnce(new Error('Internal native failure')).mockResolvedValueOnce(status('denied')))
    await render(transport)
    expect(permissionText()).toBe('查不到')
    expect(action()).toBeUndefined()
    expect(harness.container.querySelector('[role="alert"]')?.textContent).toBe('未读到日历连接状态，请重新读取。')
    await clickElement(reload())
    expect(permissionText()).toBe('未连接 · 未授权')
    expect(harness.container.querySelector('[role="alert"]')).toBeNull()
    expect(transport.read).toHaveBeenCalledTimes(2)
    expect(transport.connect).not.toHaveBeenCalled()
  })

  it('drops prior connected state while foreground refresh checks revocation', async () => {
    const revoked = deferred<IOSCalendarSnapshot>()
    const transport = client(vi.fn().mockResolvedValueOnce(status('fullAccess', true)).mockReturnValueOnce(revoked.promise))
    await render(transport)
    await act(async () => native.foreground?.())
    expect(permissionText()).toBe('正在读取')
    expect(reload().disabled).toBe(true)
    expect(action()).toBeUndefined()
    await act(async () => revoked.resolve(status('denied', true)))
    expect(permissionText()).toBe('权限已撤销')
    expect(action().textContent).toBe('断开日历')
  })

  it('does not let a late granted read overwrite a newer denied read', async () => {
    const oldRead = deferred<IOSCalendarSnapshot>()
    await render(client(vi.fn().mockReturnValueOnce(oldRead.promise).mockResolvedValueOnce(status('denied'))))
    await act(async () => native.foreground?.())
    await act(async () => oldRead.resolve(status('fullAccess', true)))
    expect(permissionText()).toBe('未连接 · 未授权')
  })

  it('withholds an old owner response after the page changes owner', async () => {
    const oldRead = deferred<IOSCalendarSnapshot>()
    const transport = client(vi.fn().mockReturnValueOnce(oldRead.promise).mockResolvedValueOnce(status('restricted', false, 'owner-b')))
    await render(transport)
    await render(transport, 'owner-b')
    await act(async () => oldRead.resolve(status('fullAccess', true)))
    expect(permissionText()).toBe('未连接 · 系统限制')
    expect(native.unsubscribe).toHaveBeenCalledOnce()
  })

  it('renders a stale binding as an error without exposing internal details', async () => {
    await render(client(vi.fn().mockRejectedValue({ code: 'stale_context', message: 'Internal owner/install mismatch' })))
    expect(permissionText()).toBe('查不到')
    expect(action()).toBeUndefined()
    expect(harness.container.querySelector('[role="alert"]')?.textContent).toBe('账号或这台手机的身份已变化，请重新打开权限页。')
  })

  it('withholds a pending allowed result when the native foreground observer fails', async () => {
    const oldRead = deferred<IOSCalendarSnapshot>()
    await render(client(vi.fn(() => oldRead.promise)))
    await act(async () => native.failed?.(new Error('Native lifecycle listener failed')))
    await act(async () => oldRead.resolve(status('fullAccess', true)))
    expect(permissionText()).toBe('查不到')
    expect(action()).toBeUndefined()
  })

  it('shows native owner refusal without exposing connection actions', async () => {
    await render(client(vi.fn().mockRejectedValue({ code: 'not_granted', message: 'Native owner guard refused' })))
    expect(permissionText()).toBe('查不到')
    expect(action()).toBeUndefined()
    expect(harness.container.querySelector('[role="alert"]')?.textContent).toBe('请在当前账号的权限页查看日历权限。')
  })

  it('connects only after a click, using the returned native binding and final snapshot', async () => {
    const settled = deferred<IOSCalendarSnapshot>()
    const transport = client()
    vi.mocked(transport.connect).mockReturnValue(settled.promise)
    await render(transport)
    const button = action()
    await act(async () => { button.click(); button.click() })
    expect(permissionText()).toBe('正在连接')
    expect(transport.connect).toHaveBeenCalledExactlyOnceWith(binding)
    await act(async () => native.foreground?.())
    expect(transport.read).toHaveBeenCalledOnce()
    await act(async () => settled.resolve(status('fullAccess', true)))
    expect(permissionText()).toBe('已连接')
    expect(action().textContent).toBe('断开日历')
  })

  it('reads native state after a denied connection without retrying the permission request', async () => {
    const transport = client(vi.fn().mockResolvedValueOnce(status('notDetermined')).mockResolvedValueOnce(status('denied')))
    vi.mocked(transport.connect).mockRejectedValue({ code: 'os_permission', message: 'Native full access denied' })
    await render(transport)
    await clickElement(action())
    expect(permissionText()).toBe('未连接 · 未授权')
    expect(harness.container.querySelector('[role="alert"]')?.textContent).toContain('连接日历需要完整日历权限')
    expect(transport.connect).toHaveBeenCalledOnce()
    expect(transport.read).toHaveBeenCalledTimes(2)
  })

  it('reconciles a lost disconnect reply without falsely restoring connection or replaying it', async () => {
    const transport = client(vi.fn().mockResolvedValueOnce(status('fullAccess', true)).mockResolvedValueOnce(status('fullAccess')))
    vi.mocked(transport.disconnect).mockRejectedValue({ code: 'execution_unknown' })
    await render(transport)
    await clickElement(action())
    expect(permissionText()).toBe('未连接 · 系统已允许')
    expect(transport.disconnect).toHaveBeenCalledExactlyOnceWith(binding)
    expect(transport.read).toHaveBeenCalledTimes(2)
    expect(transport.connect).not.toHaveBeenCalled()
  })

  it('does not publish an old owner connection result into the new owner page', async () => {
    const settled = deferred<IOSCalendarSnapshot>()
    const transport = client(vi.fn().mockResolvedValueOnce(status('fullAccess')).mockResolvedValueOnce(status('fullAccess', false, 'owner-b')))
    vi.mocked(transport.connect).mockReturnValue(settled.promise)
    await render(transport)
    await clickElement(action())
    await render(transport, 'owner-b')
    await act(async () => settled.resolve(status('fullAccess', true)))
    expect(permissionText()).toBe('未连接 · 系统已允许')
    expect(transport.connect).toHaveBeenCalledExactlyOnceWith(binding)
  })

  it('withholds old connection state when both the action and readback fail', async () => {
    const transport = client(vi.fn().mockResolvedValueOnce(status('fullAccess', true)).mockRejectedValueOnce(new Error('Read failed')))
    vi.mocked(transport.disconnect).mockRejectedValue({ code: 'stale_context', message: 'Native installation changed' })
    await render(transport)
    await clickElement(action())
    expect(permissionText()).toBe('查不到')
    expect(action()).toBeUndefined()
    expect(transport.disconnect).toHaveBeenCalledOnce()
  })
})
