import { describe, expect, it, vi } from 'vitest'
import { IOSNotificationsSettings } from '../../../../apps/desktop/src/mobile/ios-host/iosNotificationsSettings'
import type { IOSAgentClient } from '../../../../apps/desktop/src/mobile/ios-host/iosAgentClient'
const ownerId = '10000000-0000-0000-0000-000000000001', installationId = '30000000-0000-0000-0000-000000000003'
const binding = { ownerId, installationId, deviceId: `phone-${installationId}-${ownerId}` }
const originalId = '40000000-0000-0000-0000-000000000004'
const meta = (value = { enabled: false, sound: true }) => ({ value, defaults: { enabled: true, sound: true }, overrides: value })
function fixture() {
  const call = vi.fn(), guard = vi.fn()
  return { call, guard, bridge: new IOSNotificationsSettings({ call } as unknown as IOSAgentClient, binding, guard, () => originalId) }
}
describe('local iPhone notifications bridge', () => {
  it('uses only named local channels and preserves persisted values independent of defaults', async () => {
    const f = fixture(); f.call.mockResolvedValueOnce({ result: { enabled: false, sound: true } }).mockResolvedValueOnce({ result: meta() })
    expect(await f.bridge.get()).toEqual({ enabled: false, sound: true })
    expect(await f.bridge.getWithMeta()).toEqual(meta())
    expect(f.call.mock.calls.map(call => call.slice(1))).toEqual([[originalId, 'appSettings.get', ['notifications']], [originalId, 'appSettings.getWithMeta', ['notifications']]])
    expect(f.guard).toHaveBeenCalledTimes(4)
  })
  it('keeps absent/unpersisted preferences unknown without using metadata defaults', async () => {
    const f = fixture(); f.call.mockResolvedValue({ error: { code: 'settings_unavailable', message: 'Not persisted', admission: 'rejected' } })
    await expect(f.bridge.get()).rejects.toMatchObject({ code: 'settings_unavailable' })
  })
  it.each([{}, null, { enabled: true }, { enabled: 'true', sound: true }, { enabled: true, sound: true, remote: true }])('rejects incomplete value %#', async value => {
    const f = fixture(); f.call.mockResolvedValue({ result: value })
    await expect(f.bridge.get()).rejects.toMatchObject({ code: 'settings_unknown' })
  })
  it('awaits exact durable readback after the original mutation ID', async () => {
    const f = fixture(); f.call.mockResolvedValueOnce({ result: null }).mockResolvedValueOnce({ result: meta() })
    expect(await f.bridge.update({ enabled: false, sound: true }, originalId)).toEqual(meta())
    expect(f.call).toHaveBeenNthCalledWith(1, binding, originalId, 'appSettings.update', ['notifications', { enabled: false, sound: true }])
    expect(f.call).toHaveBeenNthCalledWith(2, binding, originalId, 'appSettings.getWithMeta', ['notifications'])
  })
  it('rejects a failed or changed readback without claiming the update succeeded', async () => {
    const f = fixture(); f.call.mockResolvedValueOnce({ result: null }).mockResolvedValueOnce({ result: meta({ enabled: true, sound: true }) })
    await expect(f.bridge.update({ enabled: false, sound: true }, originalId)).rejects.toMatchObject({ code: 'settings_unknown' })
  })
  it('rechecks identity after the native response and never retries an unknown mutation', async () => {
    const f = fixture(); f.call.mockImplementation(async () => { f.guard.mockImplementation(() => { throw { code: 'stale_context' } }); return { result: null } })
    await expect(f.bridge.update({ enabled: false, sound: true }, originalId)).rejects.toMatchObject({ code: 'stale_context' })
    expect(f.call).toHaveBeenCalledOnce()
  })
})
