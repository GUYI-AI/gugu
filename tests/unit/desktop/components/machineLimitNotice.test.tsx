// @vitest-environment jsdom
import { act, useState, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Device } from '@gugu/core/shared/types/chat'
import type { MachineLimitRefusal } from '@gugu/core/cloud/machineLimit'
import { DevicesContext, type DevicesContextValue } from '../../../../apps/desktop/src/store/devicesContext'
import { MachineLimitNotice } from '../../../../apps/desktop/src/components/settings/addServer/MachineLimitNotice'
import { followRendererSession, queryClient } from '../../../../apps/desktop/src/lib/replica'
import { createReactHarness, waitForCondition } from '../../../support/testHarness'

const api = vi.hoisted(() => ({ read: vi.fn() }))
vi.mock('../../../../apps/desktop/src/lib/device-labels', () => ({ currentMachineLimitRefusal: api.read }))
const initial: MachineLimitRefusal = {
  limit: 'tunnel', used: 1, max: 1, machine_id: 'new-machine', via: 'tunnel',
  machines: [{ machine_id: 'box', label: 'My server', device_ids: ['stable', 'beta'] }],
}
const endpoint = (id: string): Device => ({
  device_id: id, machine_id: 'box', label: 'My server', hostname: 'box', platform: 'linux',
  status: 'offline', is_online: false, last_seen_at: '2026-10-28T12:00:00Z', tier: id,
  capabilities: { host_kind: 'server', terminals: [], runtimes: [], host_runtime_capability: 1 },
})
let harness: ReturnType<typeof createReactHarness>
beforeEach(() => { vi.clearAllMocks(); queryClient.clear(); followRendererSession('SIGNED_IN', 'u-1'); harness = createReactHarness() })
afterEach(() => { harness.cleanup() })
const click = async (node: Element | null) => { expect(node).not.toBeNull(); await act(async () => (node as HTMLElement).click()) }
const row = () => document.querySelector('[data-machine-id="box"]')
const confirm = () => document.querySelector('[data-testid="settings-device-remove-dialog"] button:last-child')

function context(devices: Device[], remove: DevicesContextValue['remove'] = async () => {}) : DevicesContextValue {
  return { devices, loading: false, error: null, refresh: async () => {}, rename: async () => {}, remove, listBoundAgents: async () => [] }
}

describe('machine limit notice occupants', () => {
  it('uses the shared confirmation for every endpoint and keeps a partially removed machine in the slot', async () => {
    let remaining = [endpoint('stable'), endpoint('beta')]
    let failSecond = true
    const remove = vi.fn(async (id: string) => {
      if (id === 'beta' && failSecond) { failSecond = false; throw new Error('Retry this removal') }
      remaining = remaining.filter(device => device.device_id !== id)
    })
    api.read.mockImplementation(async () => remaining.length ? {
      ...initial, machines: [{ ...initial.machines![0]!, device_ids: remaining.map(device => device.device_id) }],
    } : null)
    function Provider({ children }: { children: ReactNode }) {
      const [devices, setDevices] = useState(remaining)
      return <DevicesContext.Provider value={context(devices, async (id) => {
        await remove(id)
        setDevices([...remaining])
      })}>{children}</DevicesContext.Provider>
    }
    await harness.render(<Provider><MachineLimitNotice refusal={initial} /></Provider>)
    expect(api.read).toHaveBeenCalledWith({ machine_id: 'new-machine', via: 'tunnel' })
    await waitForCondition(() => row()?.querySelector('button')?.disabled === false, 'occupant not removable')
    expect(row()?.textContent).toContain('My server')
    await click(row()?.querySelector('button') ?? null)
    expect(document.querySelector('[data-testid="settings-device-remove-dialog"]')).not.toBeNull()
    expect(remove).not.toHaveBeenCalled()
    await click(confirm())
    expect(remove.mock.calls.map(([id]) => id)).toEqual(['stable', 'beta'])
    // Checked again after the one removal that went through: the machine still holds the slot.
    await waitForCondition(() => api.read.mock.calls.length === 2, 'not checked again after the removal')
    expect(row()).not.toBeNull()
    expect(document.querySelector('[data-testid="settings-device-remove-dialog"]')?.textContent).toContain('Retry this removal')
    await click(confirm())
    expect(remove.mock.calls.map(([id]) => id)).toEqual(['stable', 'beta', 'beta'])
    await waitForCondition(() => row() === null, 'the freed slot still lists the machine')
    expect(document.querySelector('[data-testid="settings-device-remove-dialog"]')).toBeNull()
    expect(harness.container.textContent).not.toContain('1/1')
  })

  it('preserves the legacy notice and navigation when the backend has no inventory', async () => {
    const onUpgrade = vi.fn(), onRemoveMachine = vi.fn()
    await harness.render(<DevicesContext.Provider value={context([])}>
      <MachineLimitNotice refusal={{ limit: 'total', used: 10, max: 10 }} onUpgrade={onUpgrade} onRemoveMachine={onRemoveMachine} />
    </DevicesContext.Provider>)
    expect(api.read).not.toHaveBeenCalled()
    expect(harness.container.querySelector('ul')).toBeNull()
    await click(harness.container.querySelector('[data-testid="add-server-machine-limit-remove"]'))
    await click(harness.container.querySelector('[data-testid="add-server-machine-limit-upgrade"]'))
    expect(onRemoveMachine).toHaveBeenCalledOnce()
    expect(onUpgrade).toHaveBeenCalledOnce()
  })

  it('waits for the real endpoint inventory before enabling a whole-machine removal', async () => {
    api.read.mockResolvedValue(initial)
    const render = (devices: Device[]) => harness.render(<DevicesContext.Provider value={context(devices)}>
      <MachineLimitNotice refusal={initial} />
    </DevicesContext.Provider>)
    await render([endpoint('stable')])
    await waitForCondition(() => row() !== null, 'occupants not drawn')
    expect(row()?.querySelector('button')?.disabled).toBe(true)
    await render([endpoint('stable'), endpoint('beta')])
    expect(row()?.querySelector('button')?.disabled).toBe(false)
  })

  it('disables removal when the occupying machine is the current device', async () => {
    const current: Device = { ...endpoint('stable'), is_current_device: true }
    const refusal = {
      ...initial, machines: [{ ...initial.machines![0]!, device_ids: ['stable'] }],
    }
    api.read.mockResolvedValue(refusal)
    const value = context([current], vi.fn(async () => {}))
    await harness.render(<DevicesContext.Provider value={value}>
      <MachineLimitNotice refusal={refusal} />
    </DevicesContext.Provider>)
    await waitForCondition(() => row() !== null, 'occupants not drawn')
    expect(row()?.querySelector('button')?.disabled).toBe(true)
    await click(row()?.querySelector('button') ?? null)
    expect(document.querySelector('[data-testid="settings-device-remove-dialog"]')).toBeNull()
    expect(value.remove).not.toHaveBeenCalled()
  })

  it('shows a read failure and retries the authoritative RPC before offering removals', async () => {
    api.read.mockRejectedValueOnce(new Error('Current machines could not be loaded')).mockResolvedValue(initial)
    await harness.render(<DevicesContext.Provider value={context([endpoint('stable'), endpoint('beta')])}>
      <MachineLimitNotice refusal={initial} />
    </DevicesContext.Provider>)
    await waitForCondition(() => harness.container.querySelector('[role="alert"]') !== null, 'failure not said')
    expect(row()).toBeNull()
    expect(harness.container.querySelector('[role="alert"] button')?.textContent).toMatch(/^(重试|Retry)$/)
    expect(harness.container.querySelector('[role="alert"]')?.textContent).toContain('Current machines could not be loaded')
    await click(harness.container.querySelector('[role="alert"] button'))
    await waitForCondition(() => row() !== null, 'retry did not read again')
  })

  it('asks again after a removal made here, and says the slot is free once the check answers so', async () => {
    let held = true
    api.read.mockImplementation(async () => held ? initial : null)
    const onAvailable = vi.fn()
    const remove = vi.fn(async () => { held = false })
    await harness.render(<DevicesContext.Provider value={context([endpoint('stable'), endpoint('beta')], remove)}>
      <MachineLimitNotice refusal={initial} onAvailable={onAvailable} />
    </DevicesContext.Provider>)
    await waitForCondition(() => row()?.querySelector('button')?.disabled === false, 'occupant not removable')
    const before = api.read.mock.calls.length
    await click(row()?.querySelector('button') ?? null)
    await click(confirm())
    // The removal is followed by a check of the enforcement RPC (no device-list change needed): there is room now.
    await waitForCondition(() => row() === null && api.read.mock.calls.length > before, 'not checked again after the removal')
    const notice = harness.container.querySelector('[data-testid="add-server-machine-limit"]')!
    expect(notice.textContent).not.toContain('1/1')
    await click(notice.querySelector('button'))
    expect(onAvailable).toHaveBeenCalledOnce()
  })
})
