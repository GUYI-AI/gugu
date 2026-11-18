import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createDesktopFileAccess } from '../../../../apps/desktop/electron/desktopFileAccess'

const { resolve } = vi.hoisted(() => ({ resolve: vi.fn(async () => null) }))
vi.mock('@gugu/core/shared/fileResolver', async original => ({
  ...await original<typeof import('@gugu/core/shared/fileResolver')>(),
  createFileResolver: () => resolve,
}))
vi.mock('@gugu/core/cloud/deviceRuntime', async original => ({
  ...await original<typeof import('@gugu/core/cloud/deviceRuntime')>(),
  readCachedDeviceId: async () => 'device',
}))

beforeEach(() => { resolve.mockClear() })
const access = () => createDesktopFileAccess({
  auth: async () => ({ userId: 'owner', accessToken: 'memory-only-token' }),
  root: async () => null, project: async () => undefined, links: () => null, tempRoot: '/unused',
  deviceStore: '/unused', fetch: vi.fn() as never, rpc: vi.fn(), identityDb: vi.fn() as never,
})

describe('R3 program file cancellation at the account resolver', () => {
  it.each([false, true])('forwards caller cancellation with localOnly=%s', async localOnly => {
    const controller = new AbortController()
    await access().resolveAccount({ id: 'file' }, 'agent', { signal: controller.signal, localOnly })
    expect(resolve).toHaveBeenCalledExactlyOnceWith({ item_id: 'file' }, { accountId: 'owner', actorId: 'agent' }, {
      ...(localOnly ? { localOnly: true } : {}), signal: expect.any(AbortSignal),
    })
    const signal = (resolve.mock.lastCall as unknown as [unknown, unknown, { signal: AbortSignal }])[2].signal
    controller.abort('closed')
    expect(signal.reason).toBe('closed')
  })
  it('binds even an unscoped read to the signed-in account', async () => {
    const files = access()
    files.ownerChanged('owner')
    await files.resolveAccount({ id: 'file' }, null)
    expect(resolve).toHaveBeenCalledTimes(1)
    const options = (resolve.mock.calls as unknown as unknown[][])[0]?.[2]
    const signal = (options as { signal: AbortSignal }).signal
    files.ownerChanged('owner')
    expect(signal.aborted).toBe(false)
    files.ownerChanged(null)
    files.ownerChanged('owner')
    expect(signal.aborted).toBe(true)
  })
})
