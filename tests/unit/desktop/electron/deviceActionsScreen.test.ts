import { describe, expect, it, vi } from 'vitest'
import type { FamilyDeps } from '../../../../apps/desktop/electron/device-actions/catalog'
import type { DeviceActionGrants, DeviceActionGrantsStore } from '../../../../apps/desktop/electron/device-actions/grants-store'
import { createComputerFamily } from '../../../../apps/desktop/electron/device-actions/families/computer'
import { createScreenCaptureFamily } from '../../../../apps/desktop/electron/device-actions/families/screen'
import { NativeCallError } from '../../../../apps/desktop/electron/device-actions/native/mac-helper-client'
import { createDeviceActionsProvider } from '../../../../apps/desktop/electron/device-actions/provider'

function setup(platform: NodeJS.Platform = 'darwin') {
  const grants: DeviceActionGrants = { groups: { screen: true }, connectedAt: {}, deniedActions: [], denyAll: false }
  const store: DeviceActionGrantsStore = {
    read: () => grants, setGroup: vi.fn(() => grants), setActionEnabled: vi.fn(() => grants),
    setDenyAll: vi.fn(() => grants), resetActionOverrides: vi.fn(() => grants),
    record: vi.fn(), recent: () => [], onChange: () => () => undefined,
  }
  const captureScreenNative = vi.fn(async (_options: { maxEdge: number }) => ({ mimeType: 'image/jpeg', data: 'native-image', width: 1200, height: 800, displays: 2 }))
  const captureScreen = vi.fn(async () => ({ mimeType: 'image/jpeg', data: 'legacy-image', width: 640, height: 480, displays: 1 }))
  const callTool = vi.fn(async () => ({ content: [], structuredContent: { apps: [] } }))
  const stop = vi.fn()
  const cua = vi.fn(() => ({ available: () => ({ ok: true as const }), callTool, stop, dispose: vi.fn() }))
  const helperCall = vi.fn(async () => ({ status: 'granted' }))
  const deps: FamilyDeps = {
    platform, nativeDir: null, now: () => new Date(), homedir: () => '/unused',
    clipboardRead: () => '', clipboardWrite: vi.fn(), notify: vi.fn(async () => ({ shown: true })),
    openExternal: vi.fn(), trashItem: vi.fn(), jxa: vi.fn(), exec: vi.fn(),
    macHelper: () => ({ available: () => ({ ok: true as const }), call: helperCall as never, dispose: vi.fn() }),
    captureScreenNative, captureScreen, cua,
  }
  const provider = createDeviceActionsProvider({ store, deps,
    families: [createComputerFamily(null), createScreenCaptureFamily()],
    managedBy: group => group === 'computer' ? { on: false, offMessage: 'Computer Use is off' } : null })
  const invoke = async (action = 'screen.capture') => {
    const permit = await provider.provider.permit(action)
    return permit.ok ? provider.provider.run(action, {}, { callId: 'screen-test', signal: new AbortController().signal, note: () => undefined }) : permit
  }
  const entry = (name: string) => provider.capability()!.actions.find(action => action.name === name)
  return { provider, invoke, entry, grants, store, captureScreenNative, captureScreen, cua, callTool, helperCall, stop, deps }
}

describe('additive generic screen capture', () => {
  it.each(['darwin', 'win32', 'linux'] as const)('%s captures with Computer Use off and no CUA calls', async platform => {
    const { invoke, captureScreenNative, captureScreen, cua } = setup(platform)
    cua.mockImplementation(() => { throw new Error('screen.capture must not load CUA') })
    expect(await invoke()).toEqual({ ok: true, data: { width: 1200, height: 800, displays: 2,
      pictures: [{ label: 'screen.capture screenshot', mimeType: 'image/jpeg', data: 'native-image' }] } })
    expect(captureScreenNative).toHaveBeenCalledWith({ maxEdge: 1568 })
    expect(captureScreen).not.toHaveBeenCalled()
    expect(cua).not.toHaveBeenCalled()
  })

  it.each(['no-grant', 'deny-all', 'action-disabled'] as const)('honors %s before capture', async restriction => {
    const { invoke, grants, captureScreenNative } = setup()
    if (restriction === 'no-grant') grants.groups = {}
    else if (restriction === 'deny-all') grants.denyAll = true
    else grants.deniedActions = ['screen.capture']
    expect(await invoke()).toMatchObject({ ok: false, code: 'not_granted' })
    expect(captureScreenNative).not.toHaveBeenCalled()
  })

  it('reports missing native capture without using the legacy capture or CUA', async () => {
    const { invoke, deps, captureScreen, cua } = setup()
    delete deps.captureScreenNative
    expect(await invoke()).toMatchObject({ ok: false, code: 'unsupported' })
    expect(captureScreen).not.toHaveBeenCalled()
    expect(cua).not.toHaveBeenCalled()
  })

  it('does not mark AX get/find blocked when Screen Recording fails', async () => {
    const { invoke, entry, captureScreenNative, provider, helperCall } = setup()
    captureScreenNative.mockRejectedValue(new NativeCallError('os_permission', 'Screen Recording denied'))
    expect(await invoke()).toMatchObject({ ok: false, code: 'os_permission' })
    expect(entry('screen.capture')).toMatchObject({ available: false, unavailable_reason: 'os_permission' })
    expect(entry('screen.get')).toMatchObject({ available: true })
    expect(entry('screen.elements.find')).toMatchObject({ available: true })
    expect(provider.blocked('screen')).toBeNull()
    expect(helperCall).not.toHaveBeenCalled()
    captureScreenNative.mockResolvedValue({ mimeType: 'image/jpeg', data: 'native-image', width: 1200, height: 800, displays: 2 })
    expect(await invoke()).toMatchObject({ ok: true })
    expect(entry('screen.capture')).toMatchObject({ available: true })
  })

  it('does not inherit or clear a legacy AX failure', async () => {
    const { invoke, entry, callTool, provider, cua } = setup()
    callTool.mockRejectedValue(new NativeCallError('os_permission', 'Accessibility denied'))
    expect(await invoke('screen.get')).toMatchObject({ ok: false, code: 'os_permission' })
    expect(entry('screen.get')).toMatchObject({ available: false, unavailable_detail: 'Accessibility denied' })
    expect(entry('screen.capture')).toMatchObject({ available: true })
    cua.mockClear()
    expect(await invoke()).toMatchObject({ ok: true })
    expect(cua).not.toHaveBeenCalled()
    expect(provider.blocked('screen')).toEqual({ reason: 'os_permission', message: 'Accessibility denied' })
    expect(entry('screen.get')).toMatchObject({ available: false })
  })

  it.each(['win32', 'linux'] as const)('%s legacy screen.get keeps its original capture path', async platform => {
    const { invoke, captureScreen, captureScreenNative } = setup(platform)
    expect(await invoke('screen.get')).toMatchObject({ ok: true, data: { width: 640, height: 480, displays: 1,
      pictures: [{ label: 'screen.get screenshot', data: 'legacy-image' }] } })
    expect(captureScreen).toHaveBeenCalledWith({ maxEdge: 1568 })
    expect(captureScreenNative).not.toHaveBeenCalled()
  })

  it('keeps the legacy macOS Connect path and does not probe or request capture', async () => {
    const { provider, helperCall, captureScreenNative, stop } = setup()
    expect(await provider.connect('screen')).toEqual({ ok: true })
    expect(helperCall).toHaveBeenCalledWith('permissions.request', { kind: 'accessibility' }, expect.anything())
    expect(helperCall).toHaveBeenCalledTimes(1)
    expect(stop).toHaveBeenCalledTimes(1)
    expect(captureScreenNative).not.toHaveBeenCalled()
  })

  it('returns capture errors without inventing a picture', async () => {
    const { invoke, captureScreenNative } = setup()
    captureScreenNative.mockRejectedValue(new NativeCallError('execution_failed', 'No primary display source'))
    expect(await invoke()).toEqual({ ok: false, code: 'execution_failed', message: 'No primary display source' })
  })

  it('reports the delivered image dimensions after the shared picture transport resizes it', async () => {
    const { invoke, captureScreenNative, deps } = setup()
    captureScreenNative.mockResolvedValue({ mimeType: 'image/jpeg', data: 'x'.repeat(700_001), width: 1568, height: 1014, displays: 2 })
    deps.shrinkImage = vi.fn(async (_image, { maxEdge }) => ({ mimeType: 'image/jpeg',
      data: maxEdge === 1568 ? 'x'.repeat(700_001) : 'resized-image', width: maxEdge, height: maxEdge === 1568 ? 1014 : 662 }))
    expect(await invoke()).toMatchObject({ ok: true, data: { width: 1024, height: 662, displays: 2,
      pictures: [{ data: 'resized-image' }] } })
  })

  it('fails explicitly when the picture cannot fit the existing transport limit', async () => {
    const { invoke, captureScreenNative } = setup()
    captureScreenNative.mockResolvedValue({ mimeType: 'image/jpeg', data: 'x'.repeat(700_001), width: 1568, height: 1014, displays: 2 })
    expect(await invoke()).toMatchObject({ ok: false, code: 'execution_failed', message: expect.stringContaining('too large') })
  })
})
