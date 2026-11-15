// @vitest-environment jsdom
import { act, createElement } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createReactHarness, deferred } from '../../../support/testHarness'
import type { SystemPermission, SystemPermissionState } from '../../../../apps/desktop/src/platform/types'

const mocks = vi.hoisted(() => ({ check: vi.fn(), foreground: null as (() => void) | null, error: null as (() => void) | null }))
vi.mock('../../../../apps/desktop/src/platform', () => ({ platform: {
  systemPermissions: ['notifications', 'camera'], checkSystemPermission: mocks.check,
  subscribeAppForeground: (foreground: () => void, error: () => void) => {
    mocks.foreground = foreground; mocks.error = error
    return () => { mocks.foreground = null; mocks.error = null }
  },
} }))
import { useSystemPermissionStates } from '../../../../apps/desktop/src/lib/systemPermissions'
import { freshReplicaAccount } from '../../../support/replicaAccount'

function PermissionView({ permissions }: { permissions: SystemPermission[] }) {
  const { states, failed } = useSystemPermissionStates(permissions)
  return createElement('output', null, JSON.stringify({ states, failed }))
}
const active: Array<ReturnType<typeof createReactHarness>> = []
const value = () => JSON.parse(document.querySelector('output')!.textContent!)
async function render(permissions: SystemPermission[]) {
  const harness = createReactHarness(); active.push(harness)
  await harness.render(createElement(PermissionView, { permissions }))
  return harness
}
beforeEach(async () => {
  await freshReplicaAccount('owner')
 mocks.check.mockReset(); mocks.foreground = null; mocks.error = null })
afterEach(() => { for (const harness of active.splice(0)) harness.cleanup() })

it('a check started after the person came back wins over an older one still out', async () => {
  const oldRead = deferred<SystemPermissionState>()
  mocks.check.mockReturnValueOnce(oldRead.promise).mockResolvedValue('blocked')
  await render(['notifications'])
  await act(async () => { mocks.foreground!() })
  await act(async () => { oldRead.resolve('granted') })
  await vi.waitFor(() => expect(value()).toEqual({ states: { notifications: 'blocked' }, failed: false }))
  expect(mocks.check).toHaveBeenCalledTimes(2)
})

it('keeps the shown state while it is read again on the way back to the foreground', async () => {
  const refresh = deferred<SystemPermissionState>()
  mocks.check.mockResolvedValueOnce('granted').mockReturnValueOnce(refresh.promise)
  await render(['camera'])
  await vi.waitFor(() => expect(value()).toEqual({ states: { camera: 'granted' }, failed: false }))
  await act(async () => { mocks.foreground!() })
  // The last answer stays (stale) while the system is asked again; ❌ a blank row in between.
  expect(value()).toEqual({ states: { camera: 'granted' }, failed: false })
  await act(async () => { refresh.resolve('blocked') })
  expect(value()).toEqual({ states: { camera: 'blocked' }, failed: false })
})

it('a failed foreground subscription does not fail the read the page made on open', async () => {
  const read = deferred<SystemPermissionState>()
  mocks.check.mockReturnValue(read.promise)
  await render(['notifications'])
  await act(async () => { mocks.error!() })
  expect(value()).toEqual({ states: {}, failed: false })
  await act(async () => { read.resolve('granted') })
  expect(value()).toEqual({ states: { notifications: 'granted' }, failed: false })
})
