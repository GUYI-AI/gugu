import { describe, expect, it, vi } from 'vitest'
import { registerGuguDevice, type DeviceRegistrationInput } from '@gugu/core/cloud/deviceRegistration'
import { resolveLocalDeviceId, syncDeviceHeartbeat, type DeviceHeartbeatTableClient } from '@gugu/core/cloud/deviceRuntime'

const device: DeviceRegistrationInput = {
  device_id: 'new-device', machine_id: 'machine', tier: 'beta', label: 'Computer',
  hostname: 'computer', platform: 'linux', capabilities: { host_kind: 'desktop', runtimes: [], terminals: [] },
}

describe('atomic device registration client', () => {
  it('adopts the existing canonical ID before caching or registering capabilities', async () => {
    const events: string[] = []
    const calls: DeviceRegistrationInput[] = []
    const rpc = vi.fn(async (_name: string, { p_device }: { p_device: DeviceRegistrationInput }) => {
      calls.push(p_device)
      events.push(p_device.reserve_only ? 'reserve' : 'register')
      return { data: { device_id: 'existing-device', created: false }, error: null }
    })
    const client = { rpc, from: vi.fn(() => { throw new Error('raw table registration is forbidden') }) } as unknown as DeviceHeartbeatTableClient
    const env = { GUGU_TIER: 'beta' }
    const id = await resolveLocalDeviceId({ userId: 'owner', heartbeatClient: client, env,
      machineIdentifier: () => 'machine', deviceIdCacheWriter: async (_path, id) => { events.push('cache:' + id) } })
    expect(id).toBe('existing-device')
    expect(events).toEqual(['reserve', 'cache:existing-device'])
    expect(calls[0]).toMatchObject({ machine_id: 'machine', tier: 'beta', reserve_only: true,
      capabilities: { host_kind: 'desktop', runtimes: [], terminals: [] } })
    await syncDeviceHeartbeat(client, { userId: 'owner', deviceId: id, machineIdentifier: () => 'machine',
      hostname: () => 'computer', platform: () => 'linux', label: () => 'Computer',
      capabilities: { runtimes: [], terminals: [] } }, env)
    expect(calls[1].device_id).toBe('existing-device')
    expect(calls[1]).not.toHaveProperty('reserve_only')
    expect(client.from).not.toHaveBeenCalled()
  })

  it('never forwards caller-controlled ownership, status or timestamps from a legacy row', async () => {
    const rpc = vi.fn(async () => ({ data: { device_id: device.device_id, created: true }, error: null }))
    const legacyRow = { ...device, user_id: 'other-owner', status: 'online', last_seen_at: 'spoof', updated_at: 'spoof' }
    await expect(registerGuguDevice({ rpc }, legacyRow)).resolves.toEqual({ deviceId: device.device_id, created: true })
    expect(rpc).toHaveBeenCalledWith('register_gugu_device', { p_device: device })
  })

  it.each([
    [{ label: '' }, 'computer'], [{ label: '  ' }, 'computer'],
    [{ label: '', hostname: ' ' }, 'linux'],
  ])('never sends the blank label the registration RPC refuses: %j', async (override, expected) => {
    const rpc = vi.fn(async () => ({ data: { device_id: device.device_id, created: true }, error: null }))
    await registerGuguDevice({ rpc }, { ...device, ...override })
    expect(rpc).toHaveBeenCalledWith('register_gugu_device', { p_device: expect.objectContaining({ label: expected }) })
  })

  it.each([null, {}, [], { device_id: 'id' }, { device_id: 'id', created: 1 }, { device_id: ' ', created: false }])(
    'does not report success for a malformed registration receipt: %j', async data => {
      await expect(registerGuguDevice({ rpc: async () => ({ data, error: null }) }, device))
        .rejects.toMatchObject({ code: 'DEVICE_REGISTRATION_INVALID_RESPONSE' })
    })

  it('keeps a phone binding strict even if the server returns a successful different ID', async () => {
    await expect(registerGuguDevice({ rpc: async () => ({ data: { device_id: 'old-phone', created: false }, error: null }) }, device,
      { expectedDeviceId: 'phone-install-owner' })).rejects.toMatchObject({ code: 'DEVICE_REGISTRATION_IDENTITY_CHANGED' })
  })

  it.each([
    ['P0001', 'PHONE_DEVICE_ID_CONFLICT'], ['42501', 'DEVICE_REGISTRATION_FORBIDDEN'],
    ['PGRST202', 'Could not find register_gugu_device'],
  ])('preserves a %s rejection and never retries through a raw upsert', async (code, message) => {
    const rpc = vi.fn(async () => ({ data: null, error: { code, message } }))
    await expect(registerGuguDevice({ rpc }, device)).rejects.toMatchObject({ code, message })
    expect(rpc).toHaveBeenCalledTimes(1)
  })

  it('uses the same canonical ID from both concurrent registration receipts', async () => {
    let release!: () => void
    const first = new Promise<void>(resolve => { release = resolve })
    const client = { rpc: vi.fn(async (_name: string, { p_device }: { p_device: DeviceRegistrationInput }) => {
      if (p_device.device_id === 'first') await first
      else release()
      return { data: { device_id: 'canonical', created: p_device.device_id === 'second' }, error: null }
    }) }
    const results = await Promise.all(['first', 'second'].map(device_id => registerGuguDevice(client, { ...device, device_id })))
    expect(results.map(row => row.deviceId)).toEqual(['canonical', 'canonical'])
    expect(results.filter(row => row.created)).toHaveLength(1)
  })
})
