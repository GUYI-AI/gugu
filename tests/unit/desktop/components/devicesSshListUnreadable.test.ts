// @vitest-environment jsdom
// The list of machines this desktop reaches over SSH unreadable: said once with a retry; an offline row says when it was last
// online (❌ its state cell a placeholder forever, waiting for a list that failed).
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { notifyManager as readModelNotify } from '@tanstack/react-query'
import { followRendererSession, queryClient } from '../../../../apps/desktop/src/lib/replica'
import { DevicesSection } from '@/components/settings/DevicesSection'
import { DevicesContext, type DevicesContextValue } from '@/store/devicesContext'
import type { Device } from '@gugu/core/shared/types/chat'
const retryMatch = vi.hoisted(() => vi.fn(async (_deviceId: string) => true))
const restartNow = vi.hoisted(() => vi.fn(async (_deviceId: string, _version: string, _confirmedRpc: boolean) => ({ requested: true })))
vi.mock('@/lib/serverVersionRetry', () => ({ retryServerVersionMatch: retryMatch, restartServerVersionNow: restartNow, readServerVersionSwitchBusyAgents: async () => undefined }))
function device(overrides: Partial<Device> = {}): Device {
  return {
    device_id: 'remote',
    label: 'Remote Mac',
    hostname: 'remote.local',
    platform: 'mac',
    status: 'online',
    last_seen_at: '2026-07-02T00:00:00.000Z',
    is_online: true,
    is_current_device: false,
    capabilities: { terminals: [], runtimes: [], host_runtime_capability: 0 },
    ...overrides,
  }
}
function store(overrides: Partial<DevicesContextValue> = {}): DevicesContextValue {
  return {
    devices: [device()],
    loading: false,
    error: null,
    refresh: vi.fn(async () => {}),
    rename: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
    listBoundAgents: vi.fn(async () => []),
    ...overrides,
  }
}
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}
let container: HTMLDivElement
let root: Root
beforeEach(() => { readModelNotify.setScheduler((callback) => { callback() }); queryClient.clear(); followRendererSession('SIGNED_IN', 'user-1');
  restartNow.mockClear()
  retryMatch.mockClear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})
describe('DevicesSection with the SSH machine list unreadable', () => {
  it('an offline row says when it was last online; the failure is said once and its retry reads the list', async () => {
    let fails = true
    const invoke = vi.fn(async (channel: string) => {
      if (channel !== 'server-ssh-machines:describe') return null
      if (fails) throw new Error('main busy')
      return []
    })
    ;(window as unknown as { electronAPI: unknown }).electronAPI = { invoke, eventOn: () => () => undefined }
    try {
      const value = store({ devices: [device({ device_id: 'away', label: 'Away', is_online: false, status: 'offline' })] })
      await act(async () => { root.render(createElement(DevicesContext.Provider, { value }, createElement(DevicesSection))) })
      await flush()
      await vi.waitFor(() => expect(container.textContent).toContain('无法读取此电脑通过 SSH'))
      const row = container.querySelector<HTMLElement>('[data-testid="settings-device-row"][data-device-id="away"]')!
      expect(row.textContent).toContain('上次在线')
      fails = false
      const retry = [...container.querySelectorAll('button')].find((button) => button.parentElement?.textContent?.includes('无法读取此电脑通过 SSH'))!
      await act(async () => { retry.click() })
      await vi.waitFor(() => expect(container.textContent).not.toContain('无法读取此电脑通过 SSH'))
    } finally {
      delete (window as unknown as { electronAPI?: unknown }).electronAPI
    }
  })
})
