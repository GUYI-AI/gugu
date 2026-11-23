// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DevicesSection } from '@/components/settings/DevicesSection'
import { ToastContext } from '@/components/toastContext'
import { DevicesContext, type DevicesContextValue } from '@/store/devicesContext'
import type { Device } from '@gugu/core/shared/types/chat'
import { setLocalePreference } from '@/i18n'

const retry = vi.hoisted(() => vi.fn(async (_deviceId: string) => true))
const restart = vi.hoisted(() => vi.fn(async (_deviceId: string, _version: string, _confirmedRpc: boolean): Promise<{ requested: boolean; at?: number }> => ({ requested: true })))
const busyAgents = vi.hoisted(() => vi.fn(async (_deviceId: string): Promise<number | undefined> => undefined))
vi.mock('@/lib/serverVersionRetry', () => ({ retryServerVersionMatch: retry, restartServerVersionNow: restart, readServerVersionSwitchBusyAgents: busyAgents }))

const current = '0.2.58-beta.1056.1'
const target = '0.2.58-beta.1057.1'
function server(update: Device['capabilities']['server_update'] = { state: 'ready', version: target }, version = current): Device {
  return { device_id: 'remote', label: 'Remote', hostname: 'remote', platform: 'linux', status: 'online', is_online: true,
    last_seen_at: new Date().toISOString(), capabilities: { terminals: [], runtimes: [], host_kind: 'server', server_confirmed_restart: true, app_version: version, server_update: { scope: 'account', ...update } } }
}
let container: HTMLDivElement
let root: Root
const toast = vi.fn()
async function render(device = server()) {
  const value: DevicesContextValue = { devices: [device], loading: false, error: null, refresh: vi.fn(async () => {}),
    rename: vi.fn(async () => {}), remove: vi.fn(async () => {}), listBoundAgents: vi.fn(async () => []) }
  await act(async () => { root.render(createElement(ToastContext.Provider, { value: { toast } },
    createElement(DevicesContext.Provider, { value }, createElement(DevicesSection)))) })
}
function node(id: string) { return container.querySelector<HTMLElement>(`[data-testid="settings-device-${id}"]`) }
async function click(id: string) {
  expect(node(id)).not.toBeNull()
  await act(async () => { node(id)!.click() })
}
beforeEach(() => {
  restart.mockReset().mockResolvedValue({ requested: true })
  busyAgents.mockReset().mockResolvedValue(undefined)
  retry.mockReset().mockResolvedValue(true)
  toast.mockReset()
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount()); container.remove(); vi.useRealTimers()
})

describe('confirmed server update feedback', () => {
  it('shows a rollback outcome without offering another restart into the failed release', async () => {
    const device = server()
    delete device.capabilities.server_update
    device.capabilities.server_update_outcome = { kind: 'rolledBack', request: 42 }
    device.capabilities.server_rollback = { version: target, restored: current }
    await render(device)
    expect(node('notice')!.textContent).toContain('更新失败')
    expect(node('update-now')).toBeNull()
    expect(node('match-restart-now')).toBeNull()
    expect(restart).not.toHaveBeenCalled()
  })
  it.each(['zh-CN', 'en-US'] as const)('renders the counted confirmation in %s for zero and multiple running tasks', async locale => {
    setLocalePreference(locale)
    for (const count of [0, 2]) {
      busyAgents.mockResolvedValue(count)
      await render(server({ state: 'ready', version: target, busy_agents: 99 }))
      await click('update-now')
      const text = node('update-now-confirm')!.textContent!
      expect(text).not.toContain('devices.update.updateNowConfirmCount')
      expect(text).toContain(locale === 'zh-CN'
        ? `${count} 个正在运行的任务会被中断，更新完成后自动继续。`
        : `${count} running tasks will be interrupted and will automatically continue after the update.`)
      await click('update-now-no')
    }
    expect(busyAgents.mock.calls).toEqual([['remote'], ['remote']])
  })

  it('uses the uncounted confirmation when the current busy count cannot be read', async () => {
    await render(server({ state: 'ready', version: target, busy_agents: 99 }))
    await click('update-now')
    expect((node('update-now-yes') as HTMLButtonElement).disabled).toBe(false)
    const text = node('update-now-confirm')!.textContent!
    expect(text).toContain('正在运行的任务会被中断。')
    expect(text).not.toContain('99')
    expect(restart).not.toHaveBeenCalled()
  })

  it('does not apply a cancelled confirmation reading to a later confirmation', async () => {
    let first!: (value: number) => void
    let second!: (value: number) => void
    busyAgents.mockImplementationOnce(() => new Promise(resolve => { first = resolve }))
      .mockImplementationOnce(() => new Promise(resolve => { second = resolve }))
    await render(server({ state: 'ready', version: target, busy_agents: 99 }))
    await click('update-now')
    expect((node('update-now-yes') as HTMLButtonElement).disabled).toBe(true)
    await click('update-now-no')
    await click('update-now')
    expect(first).toBeTypeOf('function')
    await act(async () => { first(7) })
    expect(node('update-now-confirm')!.textContent).not.toContain('7 个')
    await act(async () => { second(0) })
    expect(node('update-now-confirm')!.textContent).toContain('0 个正在运行的任务')
    expect((node('update-now-yes') as HTMLButtonElement).disabled).toBe(false)
  })

  it('shows the actual download target and a known waiting count, leaving an unknown count unspecified', async () => {
    await render(server({ state: 'downloading', version: target }))
    expect(node('update')!.textContent).toContain(target)
    await render(server({ state: 'ready', version: target, busy_agents: 2 }))
    expect(node('update')!.textContent).toContain('2 个任务')
    await render()
    expect(node('update')!.textContent).toBe('新版本已就绪')
  })

  it('offers Update now on an older account process too, through the RPC it understands', async () => {
    const legacy = server({ state: 'ready', version: target }, '0.2.58')
    delete legacy.capabilities.server_confirmed_restart
    delete legacy.capabilities.server_update!.scope // Old account processes report neither capability nor scope.
    await render(legacy)
    await click('update-now')
    await click('update-now-yes')
    expect(restart).toHaveBeenCalledExactlyOnceWith('remote', target, false)
    expect(retry).not.toHaveBeenCalled()
  })

  it('confirms the displayed supervisor-ready target using the account restart capability', async () => {
    await render(server({ state: 'ready', version: target, scope: 'supervisor' }))
    await click('update-now')
    expect(restart).not.toHaveBeenCalled()
    await click('update-now-yes')
    expect(restart).toHaveBeenCalledExactlyOnceWith('remote', target, true)
  })

  it('requires explicit capability for a supervisor target and accepts the single-process target', async () => {
    const withoutCapability = server({ state: 'ready', version: target, scope: 'supervisor' })
    delete withoutCapability.capabilities.server_confirmed_restart
    await render(withoutCapability)
    expect(node('update-now')).toBeNull()
    await render(server({ state: 'ready', version: target, scope: undefined }))
    expect(node('update-now')).not.toBeNull()
    expect(restart).not.toHaveBeenCalled()
  })

  it.each(['zh-CN', 'en-US'] as const)('explains the legacy ready supervisor in %s when confirmation is unavailable', async (locale) => {
    setLocalePreference(locale)
    const version = '0.3.1-beta.1128'
    for (const count of [1, 12, 0, undefined]) {
      const waiting = server({ state: 'ready', version, scope: 'supervisor', busy_agents: count }, version)
      delete waiting.capabilities.server_confirmed_restart
      await render(waiting)
      const expected = locale === 'zh-CN'
        ? `服务进程 ${version} 已就绪，空闲后自动切换`
        : `Service process ${version} is ready; switches automatically when idle`
      expect(node('update')!.textContent).toBe(expected)
      expect(node('update')!.title).toBe(expected)
      expect(node('update')!.hasAttribute('data-tone')).toBe(false)
      expect(node('update-now')).toBeNull()
    }
    expect(restart).not.toHaveBeenCalled()
  })

  it.each(['account', undefined] as const)('preserves ready feedback for scope %s', async (scope) => {
    await render(server({ state: 'ready', version: target, scope, busy_agents: 2 }))
    expect(node('update')!.textContent).toBe('新版本已就绪，2 个任务在运行')
    expect(node('update')!.dataset.tone).toBe('accent')
    expect(node('update')!.title).toContain('现在重启更新')
    expect(node('update-now')).not.toBeNull()
  })

  it('sends the confirmed restart and leaves Restarting to the host’s own report', async () => {
    await render()
    await click('update-now')
    await click('update-now-yes')
    expect(restart).toHaveBeenCalledExactlyOnceWith('remote', target, true)
    expect(retry).not.toHaveBeenCalled()
    // The page keeps no copy: until the host reports `waiting`, the row is what the host last said.
    expect(node('restarting')).toBeNull()
    expect(node('update-now-confirm')).toBeNull()
    await render(server({ state: 'switching', version: target, lastOutcome: { kind: 'waiting', request: 42 } }))
    expect(node('restarting')!.textContent).toBe('正在重启…')
    expect(node('update-now')).toBeNull()
    expect(toast).not.toHaveBeenCalled()
  })

  it.each(['refused', 'rejected'])('reports a %s restart request and offers it again', async (failure) => {
    if (failure === 'refused') restart.mockResolvedValue({ requested: false })
    else restart.mockRejectedValue(new Error('remote disconnected'))
    await render(); await click('update-now'); await click('update-now-yes')
    expect(node('restarting')).toBeNull()
    expect(node('update-now')).not.toBeNull()
    expect(toast).toHaveBeenCalledWith(expect.stringContaining('未能确认'), 'error', failure === 'rejected' ? expect.any(String) : undefined)
  })

  it('keeps the question open, without a second send, while the request is on its way', async () => {
    let answer!: (value: { requested: boolean }) => void
    restart.mockReturnValue(new Promise(resolve => { answer = resolve }))
    await render(); await click('update-now'); await click('update-now-yes')
    expect((node('update-now-yes') as HTMLButtonElement).disabled).toBe(true)
    expect((node('update-now-no') as HTMLButtonElement).disabled).toBe(true)
    await act(async () => { answer({ requested: true }) })
    expect(node('update-now-confirm')).toBeNull()
    expect(restart).toHaveBeenCalledTimes(1)
  })

  it('reads Restarting from the host, so leaving the page and coming back keeps it', async () => {
    const waiting = server({ state: 'switching', version: target, lastOutcome: { kind: 'waiting', request: 42 } })
    await render(waiting)
    expect(node('restarting')).not.toBeNull()
    act(() => root.unmount()); root = createRoot(container)
    await render(waiting)
    expect(node('restarting')).not.toBeNull()
    expect(node('update')).toBeNull()
    expect(node('update-now')).toBeNull()
  })

  it.each(['online', 'offline'] as const)('keeps Restarting while the %s host still runs the old version', async state => {
    const waiting = server({ state: 'switching', version: target })
    waiting.capabilities.server_update_outcome = { kind: 'waiting', request: 42 }
    if (state === 'offline') { waiting.is_online = false; waiting.status = 'offline' }
    await render(waiting)
    expect(node('restarting')).not.toBeNull()
    expect(node('update-now')).toBeNull()
    expect(node('match-restart-now')).toBeNull()
  })

  it('stops saying Restarting once the host reports the target version, before it writes the result', async () => {
    // The new package heartbeats before its account boot finishes and records `switched` (minutes on a loaded host).
    const switched = server({ state: 'switching', version: target, lastOutcome: { kind: 'waiting', request: 42 } }, target)
    await render(switched)
    expect(node('restarting')).toBeNull()
    expect(node('update')).toBeNull()
    expect(node('update-now')).toBeNull()
  })

  it.each(['switched', 'rolledBack', 'failed', 'refused'] as const)('ends Restarting on the host’s %s result', async kind => {
    await render(server({ state: 'failed', version: target, reason: 'boot-failed', lastOutcome: { kind, request: 42 } }))
    expect(node('restarting')).toBeNull()
    expect(node('match-failed')!.textContent).toContain('更新失败')
  })

  it('continues to display a host-written pending request and ends on its result', async () => {
    await render(server({ state: 'ready', version: target, lastOutcome: { kind: 'waiting', request: 42 } }))
    expect(node('restarting')).not.toBeNull()
    expect(node('update-now')).toBeNull()
    expect(restart).not.toHaveBeenCalled()
    await render(server({ state: 'idle', version: target, lastOutcome: { kind: 'switched', request: 42 } }, target))
    expect(node('restarting')).toBeNull()
    expect(toast).not.toHaveBeenCalled()
  })

  it.each(['ready', 'failed'] as const)('never offers a confirmed restart for an offline %s host', async state => {
    const offline = server({ state, version: target, ...(state === 'failed' ? { reason: 'boot-failed' as const } : {}) })
    offline.is_online = false; offline.status = 'offline'
    await render(offline)
    expect(node('update-now')).toBeNull()
    expect(node('match-restart-now')).toBeNull()
  })
  it('shows a task boot failure while keeping the online device usable', async () => {
    const device = server()
    device.capabilities.server_boot_failures = [{ operation: 'outbox-drain', taskId: 'task-bad', message: 'router refused' }]
    await render(device)
    expect(node('boot-failure')?.textContent).toContain('router refused')
    expect(node('update-now')).not.toBeNull()
  })

  it('plain Retry never invokes the confirmed restart and shows the original transport error', async () => {
    retry.mockRejectedValueOnce(new Error('idle retry transport refused'))
    await render(server({ state: 'failed', version: target }))
    await click('match-retry')
    expect(retry).toHaveBeenCalledExactlyOnceWith('remote')
    expect(restart).not.toHaveBeenCalled()
    expect(toast).toHaveBeenCalledWith(expect.any(String), 'error', expect.stringContaining('idle retry transport refused'))
  })

})

