// @vitest-environment jsdom
import { act } from 'react'
import { setLocalePreference } from '../../../../apps/desktop/src/i18n'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clickElement, createNode, createReactHarness, deferred } from '../../../support/testHarness'

const native = vi.hoisted(() => ({ foreground: null as (() => void) | null, failed: null as ((error: unknown) => void) | null,
  active: null as ((active: boolean) => void) | null, activeInitially: false, stopActive: vi.fn(), unsubscribe: vi.fn() }))
vi.mock('../../../../apps/desktop/src/platform', () => ({ platform: {
  subscribeAppActive: (listener: (active: boolean) => void) => { native.active = listener; listener(native.activeInitially); return native.stopActive },
  subscribeAppForeground: (listener: () => void, failed: (error: unknown) => void) => {
    native.foreground = listener; native.failed = failed; return native.unsubscribe
  },
} }))
// The native client behind the replica and the panel's commands: each case puts its own transport here.
const native2 = vi.hoisted(() => ({ client: null as null | import('../../../../apps/desktop/src/mobile/ios-calendar/iosCalendarPermissions').IOSCalendarPermissionClient }))
vi.mock('../../../../apps/desktop/src/mobile/ios-calendar/iosCalendarPermissions', async (original) => ({ ...await original<object>(), iosCalendarPermissions: {
  read: (owner: string) => native2.client!.read(owner),
  connect: (binding: never) => native2.client!.connect(binding),
  disconnect: (binding: never) => native2.client!.disconnect(binding),
} }))

import { IOSCalendarPermissionsPanel } from '../../../../apps/desktop/src/mobile/ios-calendar/IOSCalendarPermissionsPanel'
import { followRendererSession } from '../../../../apps/desktop/src/lib/replica'
import { freshReplicaAccount } from '../../../support/replicaAccount'
import { IOSCalendarPermissionError } from '../../../../apps/desktop/src/mobile/ios-calendar/iosCalendarPermissions'
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
beforeEach(async () => {
  // The connection is the signed-in account's iosCalendarConnection replica: each case starts with nothing read.
  await freshReplicaAccount('owner-a')
  vi.clearAllMocks(); native.foreground = null; native.failed = null; native.active = null; native.activeInitially = false; harness = createReactHarness()
})
afterEach(() => { harness.cleanup(); vi.useRealTimers(); native2.client = null })

const permissionText = () => harness.container.querySelector('[role="status"]')?.textContent
const reload = () => harness.container.querySelector<HTMLButtonElement>('button[aria-label="重新读取日历权限"]')!
const action = () => Array.from(harness.container.querySelectorAll<HTMLButtonElement>('button')).find(button => button.textContent === '连接日历' || button.textContent === '断开日历')!
/** The native client behind the replica (the mocked module); the page's owner is the signed-in account. */
const render = async (transport: IOSCalendarPermissionClient, ownerId = 'owner-a') => {
  native2.client = transport
  followRendererSession('SIGNED_IN', ownerId)
  await harness.render(createNode(IOSCalendarPermissionsPanel, { ownerId }))
}

describe('iOS calendar permission panel', () => {
  it('updates a settled native failure when the user changes language without replaying the read', async () => {
    const transport = client(vi.fn().mockRejectedValue(new IOSCalendarPermissionError('invalid_native_status', 'native diagnostic')))
    await render(transport)
    expect(harness.container.querySelector('[role="alert"]')?.textContent).toBe('无法读取有效的日历权限状态，请重新读取。')
    await act(async () => setLocalePreference('en-US'))
    expect(harness.container.querySelector('[role="alert"]')?.textContent).toBe('Could not read a valid Calendar status. Refresh to try again.')
    expect(harness.container.querySelector('button')?.getAttribute('aria-label')).toBe('Refresh Calendar access')
    expect(harness.container.textContent).not.toMatch(/[\u3400-\u9fff]/)
    expect(transport.read).toHaveBeenCalledOnce()
    expect(transport.connect).not.toHaveBeenCalled()
  })

  it('keeps the English system permission refusal and recovered native status localized', async () => {
    setLocalePreference('en-US')
    const transport = client(vi.fn(async () => status('denied')))
    vi.mocked(transport.connect).mockRejectedValue({ code: 'os_permission', message: 'private native diagnostic' })
    await render(transport)
    const connect = Array.from(harness.container.querySelectorAll('button')).find(button => button.textContent === 'Connect')!
    await clickElement(connect)
    expect(permissionText()).toBe('Not connected, Not authorized')
    expect(harness.container.querySelector('[role="alert"]')?.textContent).toBe('Connecting Calendar requires full access. Check system settings.')
    expect(harness.container.textContent).not.toMatch(/[\u3400-\u9fff]/)
    expect(transport.connect).toHaveBeenCalledExactlyOnceWith(binding)
    expect(transport.read).toHaveBeenCalledTimes(2)
  })

  it('shows full OS access separately from the unconnected native category and never prompts on discovery', async () => {
    const transport = client()
    await render(transport)
    expect(permissionText()).toBe('未连接，系统已允许')
    expect(action().textContent).toBe('连接日历')
    expect(transport.read).toHaveBeenCalledExactlyOnceWith('owner-a')
    expect(transport.connect).not.toHaveBeenCalled()
  })

  it('keeps write-only access distinct from full access', async () => {
    await render(client(vi.fn(async () => status('writeOnly'))))
    expect(permissionText()).toBe('未连接，仅允许写入')
    expect(harness.container.textContent).toContain('读取和管理日程需要完整日历权限。')
  })

  it('shows a native read failure and retries only the status reader', async () => {
    const transport = client(vi.fn().mockRejectedValueOnce(new Error('Internal native failure')).mockResolvedValueOnce(status('denied')))
    await render(transport)
    expect(permissionText()).toBe('未知')
    expect(action()).toBeUndefined()
    expect(harness.container.querySelector('[role="alert"]')?.textContent).toBe('无法读取日历连接状态，请重新读取。')
    await clickElement(reload())
    expect(permissionText()).toBe('未连接，未授权')
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
    expect(permissionText()).toBe('未连接，未授权')
  })

  it('withholds an old owner response after the page changes owner', async () => {
    const oldRead = deferred<IOSCalendarSnapshot>()
    const transport = client(vi.fn().mockReturnValueOnce(oldRead.promise).mockResolvedValueOnce(status('restricted', false, 'owner-b')))
    await render(transport)
    await render(transport, 'owner-b')
    await act(async () => oldRead.resolve(status('fullAccess', true)))
    expect(permissionText()).toBe('未连接，系统限制')
    expect(native.unsubscribe).toHaveBeenCalledOnce()
  })

  it('renders a stale binding as an error without exposing internal details', async () => {
    await render(client(vi.fn().mockRejectedValue({ code: 'stale_context', message: 'Internal owner/install mismatch' })))
    expect(permissionText()).toBe('未知')
    expect(action()).toBeUndefined()
    expect(harness.container.querySelector('[role="alert"]')?.textContent).toBe('账号或这台手机的身份已变化，请重新打开权限页。')
  })

  it('withholds a pending allowed result when the native foreground observer fails', async () => {
    const oldRead = deferred<IOSCalendarSnapshot>()
    await render(client(vi.fn(() => oldRead.promise)))
    await act(async () => native.failed?.(new Error('Native lifecycle listener failed')))
    await act(async () => oldRead.resolve(status('fullAccess', true)))
    expect(permissionText()).toBe('未知')
    expect(action()).toBeUndefined()
  })

  it('shows native owner refusal without exposing connection actions', async () => {
    await render(client(vi.fn().mockRejectedValue({ code: 'not_granted', message: 'Native owner guard refused' })))
    expect(permissionText()).toBe('未知')
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
    expect(permissionText()).toBe('未连接，未授权')
    expect(harness.container.querySelector('[role="alert"]')?.textContent).toContain('连接日历需要完整日历权限')
    expect(transport.connect).toHaveBeenCalledOnce()
    expect(transport.read).toHaveBeenCalledTimes(2)
  })

  it('recovers a denied system sheet after a transient foreground refusal without manual refresh', async () => {
    vi.useFakeTimers()
    const transport = client(vi.fn().mockResolvedValueOnce(status('notDetermined'))
      .mockRejectedValueOnce({ code: 'not_granted' }).mockResolvedValueOnce(status('denied')))
    vi.mocked(transport.connect).mockRejectedValue({ code: 'not_granted' })
    await render(transport)
    await clickElement(action())
    expect(permissionText()).toBe('正在连接')
    expect(reload().disabled).toBe(true)
    await act(async () => vi.advanceTimersByTimeAsync(1000))
    expect(transport.read).toHaveBeenCalledTimes(2)
    expect(permissionText()).toBe('正在连接')
    await act(async () => native.active?.(true))
    expect(permissionText()).toBe('未连接，未授权')
    expect(harness.container.textContent).toContain('请在系统设置中为咕咕开启日历权限。')
    expect(harness.container.querySelector('[role="alert"]')).toBeNull()
    expect(transport.connect).toHaveBeenCalledExactlyOnceWith(binding)
    expect(transport.read).toHaveBeenCalledTimes(3)
    expect(native.stopActive).toHaveBeenCalledOnce()
  })

  it('reads a successful allow result without another status read or permission request', async () => {
    const transport = client(vi.fn(async () => status('notDetermined')))
    await render(transport)
    await clickElement(action())
    expect(permissionText()).toBe('已连接')
    expect(transport.read).toHaveBeenCalledOnce()
    expect(transport.connect).toHaveBeenCalledExactlyOnceWith(binding)
  })

  it('recovers when the app is already active before the lifecycle subscription starts', async () => {
    native.activeInitially = true
    const transport = client(vi.fn().mockResolvedValueOnce(status('notDetermined'))
      .mockRejectedValueOnce({ code: 'not_granted' }).mockResolvedValueOnce(status('denied')))
    vi.mocked(transport.connect).mockRejectedValue({ code: 'not_granted' })
    await render(transport)
    await clickElement(action())
    expect(permissionText()).toBe('未连接，未授权')
    expect(transport.read).toHaveBeenCalledTimes(3)
    expect(transport.connect).toHaveBeenCalledOnce()
    expect(native.stopActive).toHaveBeenCalledOnce()
  })

  it('keeps a persistent native refusal failed after one bounded read retry', async () => {
    vi.useFakeTimers()
    const transport = client(vi.fn().mockResolvedValueOnce(status('notDetermined')).mockRejectedValue({ code: 'not_granted' }))
    vi.mocked(transport.connect).mockRejectedValue({ code: 'not_granted' })
    await render(transport)
    await clickElement(action())
    await act(async () => native.active?.(true))
    expect(permissionText()).toBe('未知')
    expect(action()).toBeUndefined()
    expect(transport.read).toHaveBeenCalledTimes(3)
    expect(transport.connect).toHaveBeenCalledOnce()
    await act(async () => vi.advanceTimersByTimeAsync(5000))
    expect(transport.read).toHaveBeenCalledTimes(3)
  })

  it('does not retry a stale native identity after the system sheet', async () => {
    const transport = client(vi.fn().mockResolvedValueOnce(status('notDetermined')).mockRejectedValueOnce({ code: 'not_granted' }))
    vi.mocked(transport.connect).mockRejectedValue({ code: 'stale_context' })
    await render(transport)
    await clickElement(action())
    expect(permissionText()).toBe('未知')
    expect(transport.read).toHaveBeenCalledTimes(2)
    expect(transport.connect).toHaveBeenCalledOnce()
  })

  it('cancels the active-state wait when the owner changes during foreground recovery', async () => {
    vi.useFakeTimers()
    const transport = client(vi.fn().mockResolvedValueOnce(status('notDetermined'))
      .mockRejectedValueOnce({ code: 'not_granted' }).mockResolvedValueOnce(status('restricted', false, 'owner-b')))
    vi.mocked(transport.connect).mockRejectedValue({ code: 'not_granted' })
    await render(transport)
    await clickElement(action())
    await render(transport, 'owner-b')
    await act(async () => native.active?.(true))
    expect(permissionText()).toBe('未连接，系统限制')
    expect(transport.read).toHaveBeenCalledTimes(3)
    expect(transport.read).toHaveBeenLastCalledWith('owner-b')
    expect(transport.connect).toHaveBeenCalledOnce()
    expect(native.stopActive).toHaveBeenCalledOnce()
  })

  it('does not read again when the app never becomes active', async () => {
    vi.useFakeTimers()
    const transport = client(vi.fn().mockResolvedValueOnce(status('notDetermined')).mockRejectedValue({ code: 'not_granted' }))
    vi.mocked(transport.connect).mockRejectedValue({ code: 'not_granted' })
    await render(transport)
    await clickElement(action())
    await act(async () => vi.advanceTimersByTimeAsync(5000))
    expect(permissionText()).toBe('未知')
    expect(transport.read).toHaveBeenCalledTimes(2)
    expect(transport.connect).toHaveBeenCalledOnce()
    expect(native.stopActive).toHaveBeenCalledOnce()
  })

  it('reconciles a lost disconnect reply without falsely restoring connection or replaying it', async () => {
    const transport = client(vi.fn().mockResolvedValueOnce(status('fullAccess', true)).mockResolvedValueOnce(status('fullAccess')))
    vi.mocked(transport.disconnect).mockRejectedValue({ code: 'execution_unknown' })
    await render(transport)
    await clickElement(action())
    expect(permissionText()).toBe('未连接，系统已允许')
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
    expect(permissionText()).toBe('未连接，系统已允许')
    expect(transport.connect).toHaveBeenCalledExactlyOnceWith(binding)
  })

  it('withholds old connection state when both the action and readback fail', async () => {
    const transport = client(vi.fn().mockResolvedValueOnce(status('fullAccess', true)).mockRejectedValueOnce(new Error('Read failed')))
    vi.mocked(transport.disconnect).mockRejectedValue({ code: 'stale_context', message: 'Native installation changed' })
    await render(transport)
    await clickElement(action())
    expect(permissionText()).toBe('未知')
    expect(action()).toBeUndefined()
    expect(transport.disconnect).toHaveBeenCalledOnce()
  })

  it('opens again on the last answer (no reading frame) while it is read again', async () => {
    const again = deferred<IOSCalendarSnapshot>()
    const transport = client(vi.fn().mockResolvedValueOnce(status('fullAccess', true)).mockReturnValueOnce(again.promise))
    await render(transport)
    expect(permissionText()).toBe('已连接')
    // The panel closed, the run goes on (what it read stays).
    harness.cleanup({ keepReads: true }); harness = createReactHarness()
    await render(transport)
    // The replica's entry draws the first frame; the open still asks the system again.
    expect(permissionText()).toBe('已连接')
    expect(transport.read).toHaveBeenCalledTimes(2)
    await act(async () => again.resolve(status('denied', true)))
    expect(permissionText()).toBe('权限已撤销')
  })

  it('F2-3: a cold start draws no connection before native answers in this run (❌ the last run\'s "connected" with its binding)', async () => {
    const transport = client(vi.fn().mockResolvedValueOnce(status('fullAccess', true)))
    await render(transport)
    expect(permissionText()).toBe('已连接')
    // The App is closed (its snapshot written) and opened again: the grant was revoked in Settings meanwhile.
    const { queryClient } = await import('../../../../apps/desktop/src/lib/replica')
    harness.cleanup(); harness = createReactHarness()
    queryClient.clear()
    vi.resetModules()
    const fresh = await import('../../../../apps/desktop/src/lib/replica')
    fresh.followRendererSession('SIGNED_IN', 'owner-a')
    const panel = await import('../../../../apps/desktop/src/mobile/ios-calendar/IOSCalendarPermissionsPanel')
    native2.client = client(vi.fn(() => new Promise<IOSCalendarSnapshot>(() => {})))
    await harness.render(createNode(panel.IOSCalendarPermissionsPanel, { ownerId: 'owner-a' }))
    expect(permissionText()).not.toBe('已连接')
    expect(action()).toBeUndefined()
  })
})
