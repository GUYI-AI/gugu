import { describe, expect, it, vi } from 'vitest'
import type { FamilyDeps } from '../../../../apps/desktop/electron/device-actions/catalog'
import type { DeviceActionGrants, DeviceActionGrantsStore } from '../../../../apps/desktop/electron/device-actions/grants-store'
import { createScreenFamily } from '../../../../apps/desktop/electron/device-actions/families/screen'
import { NativeCallError } from '../../../../apps/desktop/electron/device-actions/native/mac-helper-client'
import { createDeviceActionsProvider } from '../../../../apps/desktop/electron/device-actions/provider'

function setup(platform: NodeJS.Platform = 'darwin') {
  const grants: DeviceActionGrants = { groups: { screen: true }, connectedAt: {}, deniedActions: [], denyAll: false }
  const store: DeviceActionGrantsStore = {
    read: () => grants, setGroup: vi.fn(() => grants), setActionEnabled: vi.fn(() => grants),
    setDenyAll: vi.fn(() => grants), resetActionOverrides: vi.fn(() => grants),
    record: vi.fn(), recent: () => [], onChange: () => () => undefined,
  }
  const captureScreen = vi.fn(async (_options: { maxEdge: number }) => ({ mimeType: 'image/jpeg', data: 'native-image', width: 1200, height: 800, displays: 2 }))
  const helperCall = vi.fn(async (_method: string, _params?: unknown) => ({ status: 'granted' }))
  const deps: FamilyDeps = {
    platform, nativeDir: null, now: () => new Date(), homedir: () => '/unused',
    clipboardRead: () => '', clipboardWrite: vi.fn(), notify: vi.fn(async () => ({ shown: true })),
    openExternal: vi.fn(), trashItem: vi.fn(), jxa: vi.fn(), exec: vi.fn(),
    macHelper: () => ({ available: () => ({ ok: true as const }), call: helperCall as never, dispose: vi.fn() }),
    captureScreen,
  }
  const provider = createDeviceActionsProvider({ store, deps, families: [createScreenFamily(platform)] })
  const invoke = async (action = 'screen.get') => {
    const permit = await provider.provider.permit(action)
    return permit.ok ? provider.provider.run(action, {}, { callId: 'screen-test', signal: new AbortController().signal, note: () => undefined }) : permit
  }
  const entry = (name: string) => provider.capability()!.actions.find(action => action.name === name)
  return { provider, invoke, entry, grants, store, captureScreen, helperCall, deps }
}

describe('screen.get: host screen capture', () => {
  it.each(['darwin', 'win32', 'linux'] as const)('%s captures a picture', async platform => {
    const { invoke, captureScreen } = setup(platform)
    expect(await invoke()).toEqual({ ok: true, data: { width: 1200, height: 800, displays: 2,
      pictures: [{ label: 'screen.get screenshot', mimeType: 'image/jpeg', data: 'native-image' }] } })
    expect(captureScreen).toHaveBeenCalledWith({ maxEdge: 1568 })
  })

  it('is the only screen action; there is no AX lookup', () => {
    const { entry } = setup()
    expect(entry('screen.capture')).toBeUndefined()
    expect(entry('screen.get')).toMatchObject({ group: 'screen', available: true })
    expect(entry('screen.elements.find')).toBeUndefined()
  })

  it.each(['no-grant', 'deny-all', 'action-disabled'] as const)('honors %s before capture', async restriction => {
    const { invoke, grants, captureScreen } = setup()
    if (restriction === 'no-grant') grants.groups = {}
    else if (restriction === 'deny-all') grants.denyAll = true
    else grants.deniedActions = ['screen.get']
    expect(await invoke()).toMatchObject({ ok: false, code: 'not_granted' })
    expect(captureScreen).not.toHaveBeenCalled()
  })

  it('reports a build without capture as unsupported', async () => {
    const { invoke, deps } = setup()
    delete deps.captureScreen
    expect(await invoke()).toMatchObject({ ok: false, code: 'unsupported' })
  })

  it('a missing Screen Recording grant is reported without asking macOS, and clears once capture works', async () => {
    const { invoke, entry, captureScreen, provider, helperCall } = setup()
    captureScreen.mockRejectedValue(new NativeCallError('os_permission', 'Screen Recording denied'))
    expect(await invoke()).toMatchObject({ ok: false, code: 'os_permission' })
    expect(entry('screen.get')).toMatchObject({ available: false, unavailable_reason: 'os_permission' })
    expect(provider.blocked('screen')).toEqual({ reason: 'os_permission', message: 'Screen Recording denied' })
    expect(helperCall).not.toHaveBeenCalled()
    captureScreen.mockResolvedValue({ mimeType: 'image/jpeg', data: 'native-image', width: 1200, height: 800, displays: 2 })
    expect(await invoke()).toMatchObject({ ok: true })
    expect(entry('screen.get')).toMatchObject({ available: true })
  })

  it('macOS Connect asks for Screen Recording (not Accessibility), then verifies with a real capture', async () => {
    const { provider, helperCall, captureScreen } = setup()
    expect(await provider.connect('screen')).toEqual({ ok: true })
    expect(helperCall.mock.calls.map(c => c[1])).toEqual([{ kind: 'screen' }])
    expect(captureScreen).toHaveBeenCalledWith({ maxEdge: 320 })
  })

  it('macOS Connect stays disconnected, with a restart hint, when the grant is refused or capture still fails', async () => {
    const refused = setup()
    refused.helperCall.mockResolvedValue({ status: 'denied' })
    expect(await refused.provider.connect('screen')).toMatchObject({ ok: false, code: 'os_permission', restart: true })
    expect(refused.captureScreen).not.toHaveBeenCalled()

    const stillBlank = setup()
    stillBlank.captureScreen.mockRejectedValue(new NativeCallError('os_permission', 'Screen Recording denied'))
    expect(await stillBlank.provider.connect('screen')).toMatchObject({ ok: false, code: 'os_permission', restart: true })
  })

  it.each(['win32', 'linux'] as const)('%s Connect verifies with a real capture and asks nothing', async platform => {
    const { provider, helperCall, captureScreen } = setup(platform)
    expect(await provider.connect('screen')).toEqual({ ok: true })
    expect(helperCall).not.toHaveBeenCalled()
    expect(captureScreen).toHaveBeenCalledWith({ maxEdge: 320 })
  })

  it('returns capture errors without inventing a picture', async () => {
    const { invoke, captureScreen } = setup()
    captureScreen.mockRejectedValue(new NativeCallError('execution_failed', 'No primary display source'))
    expect(await invoke()).toEqual({ ok: false, code: 'execution_failed', message: 'No primary display source' })
  })

  it('reports the delivered image dimensions after the shared picture transport resizes it', async () => {
    const { invoke, captureScreen, deps } = setup()
    captureScreen.mockResolvedValue({ mimeType: 'image/jpeg', data: 'x'.repeat(700_001), width: 1568, height: 1014, displays: 2 })
    deps.shrinkImage = vi.fn(async (_image, { maxEdge }) => ({ mimeType: 'image/jpeg',
      data: maxEdge === 1568 ? 'x'.repeat(700_001) : 'resized-image', width: maxEdge, height: maxEdge === 1568 ? 1014 : 662 }))
    expect(await invoke()).toMatchObject({ ok: true, data: { width: 1024, height: 662, displays: 2,
      pictures: [{ data: 'resized-image' }] } })
  })

  it('fails explicitly when the picture cannot fit the existing transport limit', async () => {
    const { invoke, captureScreen } = setup()
    captureScreen.mockResolvedValue({ mimeType: 'image/jpeg', data: 'x'.repeat(700_001), width: 1568, height: 1014, displays: 2 })
    expect(await invoke()).toMatchObject({ ok: false, code: 'execution_failed', message: expect.stringContaining('too large') })
  })
})
