// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createReactHarness, device, renderWithAppProviders } from '../../support/testHarness'

/**
 * The phone's 新项目: the machine's default projects directory read before, a read again that fails is said with a retry
 * under the rows, the directory read staying (❌ shown as current).
 */
const world = vi.hoisted(() => ({ fail: false, devices: [] as unknown[] }))
vi.mock('@/store/devicesContext', () => ({ useDevicesStore: () => ({ devices: world.devices, refresh: vi.fn() }) }))
vi.mock('@/mobile/agent-watch/useMachineLabel', () => ({ useMachineLabel: () => ({ label: () => 'Mac', isHome: () => false }) }))
vi.mock('@/mobile/agent-watch/machine-list', () => ({ workspaceDevices: (rows: unknown[]) => rows, visibleMachines: (rows: unknown[]) => rows }))
vi.mock('@/session/renderer/features/settings/app-settings-client', async (original) => {
  const { replica } = await import('@/lib/replica')
  const model = replica({
    name: 'phoneNewProjectSettingsTest',
    scope: 'device',
    read: async (_owner: string, _key: string, _host: string) => {
      if (world.fail) throw new Error('machine unreachable')
      return { value: { defaultProjectsDirectory: '/home/me/Projects' } }
    },
  })
  return { ...(await original<object>()), appSettingsModel: model }
})

const { PhoneNewProjectPage } = await import('../../../apps/desktop/src/mobile/partners/PhoneNewProjectPage')
const { appSettingsModel } = await import('@/session/renderer/features/settings/app-settings-client')

let h: ReturnType<typeof createReactHarness>
beforeEach(() => {
  h = createReactHarness()
  world.fail = false
  world.devices = [device('mac', [], { is_online: true })]
})
afterEach(() => h.cleanup())

const folderRow = () => h.container.querySelector('[data-testid="phone-new-project-folder-row"]')?.textContent ?? ''
const failed = () => h.container.querySelector('[data-refresh-failed]')

it('read before, the directory read again failing is said with a retry; the directory stays', async () => {
  await renderWithAppProviders(h, <PhoneNewProjectPage active onBack={() => undefined} onCreated={() => undefined} />)
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
  expect(folderRow()).toContain('Projects')
  expect(failed()).toBeNull()
  world.fail = true
  await act(async () => { await (appSettingsModel as unknown as { refresh: (...args: string[]) => Promise<unknown> }).refresh('localProject', 'mac').catch(() => undefined) })
  expect(failed()).not.toBeNull()
  expect(folderRow()).toContain('Projects')
  world.fail = false
  await act(async () => { (failed()!.querySelector('button') as HTMLButtonElement).click() })
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
  expect(failed()).toBeNull()
})
