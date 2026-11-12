// @vitest-environment jsdom
// #1925 An App bound to the person's own assistant: the host opens its own screens for it, each by its existing entry and
// nothing else; the setup steps the App draws move through the built-in view's own advanceSetup; the shell's snapshot is
// passed on as an App may see it — no chat, device or account id, no path — and only when it changes.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AssistantShellActions, AssistantShellSnapshot } from '../../../../apps/desktop/src/lib/assistantShellBridge'

vi.mock('../../../../apps/desktop/src/lib/myAssistant', () => ({ isMyAssistant: () => false }))

const { installAssistantShellBridge, publishAssistantShell, readAssistantShellBridge } = await import('../../../../apps/desktop/src/lib/assistantShellBridge')
const { advanceAssistantSetup, appAssistantStatusOf, openAssistantScreen, renameAssistantFor, startAssistantAppStatus } = await import('../../../../apps/desktop/src/lib/assistantAppHost')
const { UI_EVENTS } = await import('../../../../apps/desktop/src/lib/uiEvents')
const { ASSISTANT_NAME_MAX, ASSISTANT_SCREENS, isAssistantLayerScreen, shownAssistantSchema } = await import('../../../../apps/desktop/src/session/shared/extensions/assistant-binding')
const { ASSISTANT_NAME_MAX: BUILT_IN_NAME_MAX } = await import('../../../../apps/desktop/src/lib/assistantSetup')

const OWNER = '11000000-0000-4000-8000-000000000001'
const OTHER = '22000000-0000-4000-8000-000000000002'
const CHAT = '33000000-0000-4000-8000-000000000003'
const ASSISTANT = '44000000-0000-4000-8000-000000000004'
const DEVICE = '55000000-0000-4000-8000-000000000005'
const CLOUD = '66000000-0000-4000-8000-000000000006'
const FACE = 'data:image/webp;base64,UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAwA0JaQAA3AA/vuUAAA='

const snapshot = (over: Partial<AssistantShellSnapshot> = {}): AssistantShellSnapshot => ({
  cloudAvailable: true, canHostHere: true, cloud: null, loadError: null,
  assistant: { id: ASSISTANT, display_name: 'Dot', avatar: `https://storage.example/avatars/${ASSISTANT}/face.png`, created_at: '2026-11-01T00:00:00Z' },
  assistantState: 'found', ownerName: 'Ann', deviceCount: 2, ownerId: OWNER, ownerAvatar: `https://storage.example/avatars/${OWNER}.png`,
  chatId: CHAT, chatReadFailed: false,
  home: { kind: 'computer', deviceId: DEVICE, thisDevice: true, label: 'Ann’s MacBook', online: true, known: true, hostKind: 'desktop' },
  setup: 'connect', member: null, preparing: false, ...over,
})

installAssistantShellBridge()
const bridge = readAssistantShellBridge()!
const actions = { renameAssistant: vi.fn(async () => undefined), openLook: vi.fn(), openModel: vi.fn(), refreshCloud: vi.fn(), advanceSetup: vi.fn() } satisfies AssistantShellActions

/** Every entry a screen could be opened by: the settings sections, the one close confirmation, the agent settings tabs. */
const opened: string[] = []
window.addEventListener(UI_EVENTS.openSettings, (event) => opened.push(`settings:${(event as CustomEvent<{ section: string }>).detail.section}`))
window.addEventListener(UI_EVENTS.closeAssistant, () => opened.push('close'))
const entries = () => [...opened, ...actions.openLook.mock.calls.map(() => 'look'), ...actions.openModel.mock.calls.map(() => 'model'),
  ...actions.advanceSetup.mock.calls.map(([next]) => `advance:${next}`), ...actions.renameAssistant.mock.calls.map(() => 'rename'), ...actions.refreshCloud.mock.calls.map(() => 'refresh')]

beforeEach(() => {
  opened.length = 0
  for (const spy of Object.values(actions)) spy.mockClear()
  bridge.setActions(actions)
  publishAssistantShell(snapshot())
})

describe('each screen opens by its existing entry, and nothing else', () => {
  const ENTRY = { close: 'close', look: 'look', model: 'model', devices: 'settings:devices' } as const

  // The assistant's own pages (setup, settings, move, connected apps, projects, capabilities) go over the App's panel, never
  // Settings (owner 11-12); `health` (49) is a phone's own page: main answers `unsupported` on a
  // computer and never asks the window.
  const SHELL_SCREENS = ASSISTANT_SCREENS.filter((screen) => !isAssistantLayerScreen(screen) && screen !== 'health')

  it.each(SHELL_SCREENS)('%s', (screen) => {
    openAssistantScreen(screen, OWNER)
    expect(entries()).toEqual([ENTRY[screen as keyof typeof ENTRY]])
  })

  it('the shell\'s screens are exactly these four; the assistant\'s own pages go over the App\'s panel, health is a phone\'s', () => {
    expect([...SHELL_SCREENS].sort()).toEqual(Object.keys(ENTRY).sort())
    expect(ASSISTANT_SCREENS.filter(isAssistantLayerScreen)).toEqual(['setup', 'move', 'connected-apps', 'settings', 'projects', 'capabilities'])
    expect(ASSISTANT_SCREENS).toContain('health')
    expect(() => openAssistantScreen('health', OWNER)).toThrow()
    expect(entries()).toEqual([])
  })

  it('an unknown value, or a panel page, opens nothing here', () => {
    for (const screen of ['setup', 'move', 'connected-apps', 'settings', 'projects', 'capabilities', 'chat', '', 'Close', 'memory']) expect(() => openAssistantScreen(screen as never, OWNER)).toThrow()
    expect(entries()).toEqual([])
  })

  it('for another account than the window shows, or before the window shows one: nothing', () => {
    expect(() => openAssistantScreen('close', OTHER)).toThrow()
    publishAssistantShell(snapshot({ ownerId: null }))
    expect(() => openAssistantScreen('devices', OWNER)).toThrow()
    expect(entries()).toEqual([])
  })

  it('look and model wait for the shell\'s settings: refused, not dropped, while they are not there', () => {
    bridge.setActions(null)
    expect(() => openAssistantScreen('look', OWNER)).toThrow()
    expect(() => openAssistantScreen('model', OWNER)).toThrow()
    expect(entries()).toEqual([])
  })
})

describe('rename: the shell\'s own renameAssistant, by the built-in name field\'s rule', () => {
  it('trims and saves through renameAssistant', async () => {
    await renameAssistantFor('  Pip  ', OWNER)
    expect(actions.renameAssistant).toHaveBeenCalledExactlyOnceWith('Pip')
  })

  it('the same name saves nothing; empty or over the field\'s limit is refused, nothing saved', async () => {
    await renameAssistantFor(' Dot ', OWNER)
    await expect(renameAssistantFor('   ', OWNER)).rejects.toThrow()
    await expect(renameAssistantFor('x'.repeat(ASSISTANT_NAME_MAX + 1), OWNER)).rejects.toThrow()
    expect(actions.renameAssistant).not.toHaveBeenCalled()
    expect(ASSISTANT_NAME_MAX).toBe(BUILT_IN_NAME_MAX)
  })

  it('another account, or no assistant shown: nothing saved', async () => {
    await expect(renameAssistantFor('Pip', OTHER)).rejects.toThrow()
    publishAssistantShell(snapshot({ assistantState: 'none', assistant: null }))
    await expect(renameAssistantFor('Pip', OWNER)).rejects.toThrow()
    expect(actions.renameAssistant).not.toHaveBeenCalled()
  })

  it('a failed save is a failure', async () => {
    actions.renameAssistant.mockRejectedValueOnce(new Error('offline'))
    await expect(renameAssistantFor('Pip', OWNER)).rejects.toThrow('offline')
  })
})

describe('advanceSetup: the built-in view\'s own action, with the same rule', () => {
  it.each([['connect', 'ready', 'ready'], ['connect', 'done', null], ['ready', 'done', null]] as const)('from %s to %s', (from, next, written) => {
    publishAssistantShell(snapshot({ setup: from }))
    advanceAssistantSetup(next, OWNER)
    expect(actions.advanceSetup).toHaveBeenCalledExactlyOnceWith(written)
    expect(opened).toEqual([])
  })

  it.each([['shell', 'ready'], ['shell', 'done'], [null, 'ready'], [null, 'done'], ['ready', 'ready']] as const)('not from %s to %s', (from, next) => {
    publishAssistantShell(snapshot({ setup: from }))
    expect(() => advanceAssistantSetup(next, OWNER)).toThrow()
    expect(actions.advanceSetup).not.toHaveBeenCalled()
  })

  it('not for another account', () => {
    expect(() => advanceAssistantSetup('ready', OTHER)).toThrow()
    expect(actions.advanceSetup).not.toHaveBeenCalled()
  })
})

describe('the snapshot an App may see', () => {
  const said = (value: unknown) => JSON.stringify(value)

  it('holds no chat, device or account id, no path or storage address — the names the built-in steps show, and those alone', () => {
    for (const shell of [snapshot(), snapshot({ home: { kind: 'cloud', deviceId: CLOUD }, cloud: { state: 'awake', deviceId: CLOUD, error: null, since: null, adoptingFrom: DEVICE } })]) {
      const status = appAssistantStatusOf(shell, FACE)
      expect(shownAssistantSchema.parse(status)).toEqual(status)
      for (const secret of [OWNER, CHAT, ASSISTANT, DEVICE, CLOUD, 'storage.example', 'https:']) expect(said(status)).not.toContain(secret)
    }
    // The home computer's name as the person named it, and what the ready step calls the person; nothing on the cloud.
    expect(appAssistantStatusOf(snapshot(), FACE)).toMatchObject({ home: { label: 'Ann’s MacBook' }, ownerName: 'Ann' })
    expect(appAssistantStatusOf(snapshot({ home: { kind: 'cloud', deviceId: CLOUD }, cloud: null }), FACE).home).toMatchObject({ label: null })
    expect(appAssistantStatusOf(snapshot({ ownerName: '   ' }), FACE).ownerName).toBeNull()
    // A face that is not the host's own small image is not passed on.
    expect(appAssistantStatusOf(snapshot(), `https://storage.example/avatars/${ASSISTANT}.png`).avatar).toBeNull()
    expect(appAssistantStatusOf(snapshot(), FACE).avatar).toBe(FACE)
  })

  it('says the theme hue of its bird, none for a photo face or before it is found', () => {
    expect(appAssistantStatusOf(snapshot({ assistant: { ...snapshot().assistant!, avatar: null } }), null).tint).toEqual(expect.any(Number))
    expect(appAssistantStatusOf(snapshot({ assistant: { ...snapshot().assistant!, avatar: 'https://storage.example/a.png' } }), null).tint).toBeNull()
    expect(appAssistantStatusOf(snapshot({ assistantState: 'loading' }), null).tint).toBeNull()
  })

  it('says unreadable apart from none and loading, with no name or face until found', () => {
    expect(appAssistantStatusOf(snapshot({ assistantState: 'unreadable', assistant: null, home: null }), null)).toMatchObject({ assistant: 'unreadable', name: null, avatar: null, home: null })
    expect(appAssistantStatusOf(snapshot({ assistantState: 'none', assistant: null, home: null, setup: 'shell' }), null)).toMatchObject({ assistant: 'none', setup: 'shell' })
    expect(appAssistantStatusOf(snapshot({ assistantState: 'loading' }), FACE)).toMatchObject({ assistant: 'loading', name: null, avatar: null })
  })

  it('keeps an unknown membership null, never false', () => {
    expect(appAssistantStatusOf(snapshot({ member: null }), null).member).toBeNull()
    expect(appAssistantStatusOf(snapshot({ member: false }), null).member).toBe(false)
    expect(appAssistantStatusOf(snapshot({ member: true }), null).member).toBe(true)
  })

  it('says where it lives as a kind, and whether it answers there', () => {
    const home = (shell: Partial<AssistantShellSnapshot>) => appAssistantStatusOf(snapshot(shell), null).home
    const computer = (over: object) => ({ kind: 'computer' as const, deviceId: DEVICE, thisDevice: false, label: 'x', online: false, known: true, ...over })
    expect(home({ home: computer({ thisDevice: true, online: true }) })).toEqual({ kind: 'this-computer', online: true, label: 'x' })
    expect(home({ home: computer({ online: false, label: null }) })).toEqual({ kind: 'other-computer', online: false, label: null })
    expect(home({ home: computer({ hostKind: 'server', online: true, label: '  ' }) })).toEqual({ kind: 'server', online: true, label: null })
    for (const [state, online] of [['awake', true], ['asleep', true], ['waking', true], ['provisioning', false], ['error', false]] as const) {
      expect(home({ home: { kind: 'cloud', deviceId: CLOUD }, cloud: { state, deviceId: CLOUD, error: null, since: null } })).toEqual({ kind: 'cloud', online, label: null })
    }
    expect(home({ home: { kind: 'cloud', deviceId: CLOUD }, cloud: null })).toEqual({ kind: 'cloud', online: false, label: null })
    expect(home({ home: null })).toBeNull()
  })

  it('passes the setup step, preparing, the cloud\'s availability and its failure class — a class, never a message', () => {
    expect(appAssistantStatusOf(snapshot({ setup: 'ready', preparing: true, cloudAvailable: false, loadError: 'network' }), null))
      .toMatchObject({ setup: 'ready', preparing: true, cloudAvailable: false, loadError: 'network' })
    expect(appAssistantStatusOf(snapshot({ loadError: `Error: device ${DEVICE} gone` }), null).loadError).toBe('failed')
    // Its cloud home, made during setup, still being made or failed to be: the built-in drew the host's setup over the page.
    const cloud = (state: string, over: Partial<AssistantShellSnapshot> = {}) => appAssistantStatusOf(snapshot({
      home: { kind: 'cloud', deviceId: CLOUD }, cloud: { state, deviceId: CLOUD, error: null, since: null } as never, ...over }), null).preparing
    expect(cloud('provisioning')).toBe(true)
    expect(cloud('error')).toBe(true)
    expect(cloud('awake')).toBe(false)
    expect(cloud('error', { setup: null })).toBe(false)
    expect(appAssistantStatusOf(snapshot({ assistant: { id: ASSISTANT, display_name: 'D'.repeat(500), avatar: null, created_at: null } }), null).name).toHaveLength(200)
  })
})

describe('passing it on', () => {
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

  it('once at the start, again only when what an App sees changed — a change only of membership too', async () => {
    const push = vi.fn(async () => undefined)
    const stop = startAssistantAppStatus({ shell: bridge, face: async () => FACE, push, warn: vi.fn() })
    await flush()
    expect(push).toHaveBeenCalledExactlyOnceWith({ ownerId: OWNER, status: appAssistantStatusOf(snapshot(), FACE) })
    publishAssistantShell(snapshot({ deviceCount: 9 }))
    await flush()
    expect(push).toHaveBeenCalledOnce()
    publishAssistantShell(snapshot({ deviceCount: 9, member: true }))
    await flush()
    expect(push).toHaveBeenCalledTimes(2)
    expect(push).toHaveBeenLastCalledWith(expect.objectContaining({ status: expect.objectContaining({ member: true }) }))
    stop()
    publishAssistantShell(snapshot({ member: false }))
    await flush()
    expect(push).toHaveBeenCalledTimes(2)
  })

  it('a face drawn late for an older snapshot never lands over a newer one', async () => {
    let release: (face: string) => void = () => undefined
    const faces = [new Promise<string>((resolve) => { release = resolve }), Promise.resolve(FACE)]
    const push = vi.fn(async () => undefined)
    const stop = startAssistantAppStatus({ shell: bridge, face: () => faces.shift()!, push, warn: vi.fn() })
    publishAssistantShell(snapshot({ setup: 'ready' }))
    await flush()
    release(FACE)
    await flush()
    expect(push).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ status: expect.objectContaining({ setup: 'ready' }) }))
    stop()
  })

  it('passes nothing before the window knows whose it is, and tries again after a failed hand-over', async () => {
    publishAssistantShell(snapshot({ ownerId: null }))
    const push = vi.fn(async (): Promise<unknown> => { throw new Error('main is busy') })
    const warn = vi.fn()
    const stop = startAssistantAppStatus({ shell: bridge, face: async () => FACE, push, warn })
    await flush()
    expect(push).not.toHaveBeenCalled()
    publishAssistantShell(snapshot())
    await flush()
    expect(push).toHaveBeenCalledOnce()
    expect(warn).toHaveBeenCalledOnce()
    push.mockResolvedValue(undefined)
    publishAssistantShell(snapshot({ deviceCount: 5 }))
    await flush()
    expect(push).toHaveBeenCalledTimes(2)
    stop()
  })
})
