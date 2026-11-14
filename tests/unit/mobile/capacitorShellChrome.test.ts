import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  platform: vi.fn(), setActive: vi.fn(), native: vi.fn(), pluginAvailable: vi.fn(), syncTone: vi.fn(), tone: vi.fn(), preference: vi.fn(),
  subscribeTone: vi.fn(), subscribePreference: vi.fn(),
}))
vi.mock('@capacitor/core', () => ({
  Capacitor: { getPlatform: mocks.platform, isNativePlatform: mocks.native, isPluginAvailable: mocks.pluginAvailable }, registerPlugin: () => ({ syncTone: mocks.syncTone, setActive: mocks.setActive }),
}))
vi.mock('../../../apps/desktop/src/session/renderer/lib/theme/host-theme', () => ({
  readEffectiveHostTheme: mocks.tone, readThemePreference: mocks.preference,
  subscribeToHostTheme: mocks.subscribeTone, subscribeToThemePreference: mocks.subscribePreference,
}))
vi.mock('../../../apps/desktop/src/lib/log', () => ({ rendererLogger: () => ({ error: vi.fn() }) }))
import { startShellChromeTone, holdIOSImageViewerChrome } from '../../../apps/desktop/src/platform/capacitorShellChrome'

describe('native startup theme mirror', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mocks.native.mockReturnValue(true)
    mocks.pluginAvailable.mockReturnValue(true)
    mocks.syncTone.mockResolvedValue(undefined)
    mocks.tone.mockReturnValue('dark')
    mocks.preference.mockReturnValue('dark')
  })

  it('sends both the stored preference and resolved initial tone', () => {
    startShellChromeTone()
    expect(mocks.syncTone).toHaveBeenCalledWith({ preference: 'dark', tone: 'dark' })
  })

  it('mirrors a move to system even when the effective tone stays dark', () => {
    startShellChromeTone()
    mocks.preference.mockReturnValue('system')
    mocks.subscribePreference.mock.calls[0][0]()
    expect(mocks.syncTone).toHaveBeenLastCalledWith({ preference: 'system', tone: 'dark' })
  })

  it('does not install native behavior in the web client', () => {
    mocks.native.mockReturnValue(false)
    startShellChromeTone()
    expect(mocks.syncTone).not.toHaveBeenCalled()
    expect(mocks.subscribePreference).not.toHaveBeenCalled()
  })

  it('does not call or subscribe to an absent native theme plugin on iOS', () => {
    mocks.pluginAvailable.mockReturnValue(false)
    startShellChromeTone()
    expect(mocks.syncTone).not.toHaveBeenCalled()
    expect(mocks.subscribeTone).not.toHaveBeenCalled()
  })
})

describe('iOS image viewer native appearance', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mocks.platform.mockReturnValue('ios')
    mocks.pluginAvailable.mockReturnValue(true)
    mocks.setActive.mockResolvedValue(undefined)
  })
  it.each(['android', 'web'])('leaves %s chrome alone', (platform) => {
    mocks.platform.mockReturnValue(platform)
    holdIOSImageViewerChrome()()
    expect(mocks.setActive).not.toHaveBeenCalled()
  })
  it('restores chrome after an in-flight open finishes', async () => {
    let finish!: () => void
    mocks.setActive.mockReturnValueOnce(new Promise<void>(resolve => { finish = resolve }))
    const close = holdIOSImageViewerChrome()
    close()
    expect(mocks.setActive).toHaveBeenCalledTimes(1)
    finish()
    await vi.waitFor(() => expect(mocks.setActive).toHaveBeenLastCalledWith({ active: false }))
  })
  it('does not invoke a missing iOS capability', () => {
    mocks.pluginAvailable.mockReturnValue(false)
    holdIOSImageViewerChrome()()
    expect(mocks.setActive).not.toHaveBeenCalled()
  })
})
