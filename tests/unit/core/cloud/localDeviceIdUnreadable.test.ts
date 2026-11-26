import { describe, expect, it, vi } from 'vitest'

vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:os')>()),
  platform: () => 'aix',
}))

const { createLocalDeviceIdResolver, LocalDeviceIdUnreadableError } = await import('@gugu/core/cloud/deviceRuntime')

describe('local device ID resolution', () => {
  it('reports a hardware read failure only to callers that require a reason', async () => {
    const registration = vi.fn()
    const warn = vi.fn()
    const resolve = createLocalDeviceIdResolver({
      getAuth: async () => ({ accessToken: 'test', userId: 'owner' }),
      heartbeatClient: () => ({ rpc: registration }) as never,
      capabilities: async () => ({ terminals: [], runtimes: [] }),
      env: {},
      warn,
    })

    const [optional, required] = await Promise.allSettled([resolve(), resolve({ reportUnreadable: true })])
    expect(optional).toEqual({ status: 'fulfilled', value: null })
    expect(required).toMatchObject({
      status: 'rejected',
      reason: expect.objectContaining({
        code: 'DEVICE_ID_UNREADABLE',
        cause: expect.objectContaining({ message: 'unsupported platform aix' }),
      }),
    })
    expect(required.status === 'rejected' && required.reason).toBeInstanceOf(LocalDeviceIdUnreadableError)
    expect(registration).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith('device id resolve failed: unsupported platform aix')
  })

  it('leaves a connection failure unresolved even when a hardware reason was requested', async () => {
    const connection = new Error('connection interrupted')
    const resolve = createLocalDeviceIdResolver({
      getAuth: async () => { throw connection },
      heartbeatClient: vi.fn(),
      capabilities: vi.fn(),
      warn: vi.fn(),
    })

    await expect(resolve({ reportUnreadable: true })).resolves.toBeNull()
  })
})
