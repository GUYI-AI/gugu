// @vitest-environment jsdom
// #1925 An App bound to the person's own assistant: the host opens its own screens for it, each by its existing entry and
// nothing else; the setup steps the App draws move through the built-in view's own advanceSetup; the shell's snapshot is
// passed on as an App may see it — no chat, device or account id, no path — and only when it changes.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AssistantShellActions, AssistantShellSnapshot } from '../../../../apps/desktop/src/lib/assistantShellBridge'

vi.mock('../../../../apps/desktop/src/lib/myAssistant', () => ({ isMyAssistant: () => false }))

const { installAssistantShellBridge, publishAssistantShell, readAssistantShellBridge } = await import('../../../../apps/desktop/src/lib/assistantShellBridge')
const { advanceAssistantSetup, appAssistantStatusOf, openAssistantScreen, startAssistantAppStatus } = await import('../../../../apps/desktop/src/lib/assistantAppHost')
const { UI_EVENTS } = await import('../../../../apps/desktop/src/lib/uiEvents')
const { ASSISTANT_SCREENS, appAssistantStatusSchema } = await import('../../../../apps/desktop/src/session/shared/extensions/assistant-binding')

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
  const ENTRY = {
    setup: 'settings:assistant', move: 'settings:assistant', close: 'close', look: 'look', model: 'model',
    devices: 'settings:devices', 'connected-apps': 'settings:connectors',
  } as const

  it.each(ASSISTANT_SCREENS)('%s', (screen) => {
    openAssistantScreen(screen, OWNER)
    expect(entries()).toEqual([ENTRY[screen]])
  })

  it('the list is exactly these seven', () => {
    expect([...ASSISTANT_SCREENS].sort()).toEqual(Object.keys(ENTRY).sort())
  })

  it('an unknown value opens nothing', () => {
    for (const screen of ['settings', 'chat', '', 'Close', 'memory']) expect(() => openAssistantScreen(screen as never, OWNER)).toThrow()
    expect(entries()).toEqual([])
  })

  it('for another account than the window shows, or before the window shows one: nothing', () => {
    expect(() => openAssistantScreen('close', OTHER)).toThrow()
    publishAssistantShell(snapshot({ ownerId: null }))
    expect(() => openAssistantScreen('move', OWNER)).toThrow()
    expect(entries()).toEqual([])
  })

  it('look and model wait for the shell\'s settings: refused, not dropped, while they are not there', () => {
    bridge.setActions(null)
    expect(() => openAssistantScreen('look', OWNER)).toThrow()
    expect(() => openAssistantScreen('model', OWNER)).toThrow()
    expect(entries()).toEqual([])
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

  it('holds no chat, device or account id, no path or storage address, and nothing of the owner', () => {
    for (const shell of [snapshot(), snapshot({ home: { kind: 'cloud', deviceId: CLOUD }, cloud: { state: 'awake', deviceId: CLOUD, error: null, since: null, adoptingFrom: DEVICE } })]) {
      const status = appAssistantStatusOf(shell, FACE)
      expect(appAssistantStatusSchema.parse(status)).toEqual(status)
      for (const secret of [OWNER, CHAT, ASSISTANT, DEVICE, CLOUD, 'storage.example', 'https:', 'MacBook', 'Ann']) expect(said(status)).not.toContain(secret)
    }
    // A face that is not the host's own small image is not passed on.
    expect(appAssistantStatusOf(snapshot(), `https://storage.example/avatars/${ASSISTANT}.png`).avatar).toBeNull()
    expect(appAssistantStatusOf(snapshot(), FACE).avatar).toBe(FACE)
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
    expect(home({ home: computer({ thisDevice: true, online: true }) })).toEqual({ kind: 'this-computer', online: true })
    expect(home({ home: computer({ online: false }) })).toEqual({ kind: 'other-computer', online: false })
    expect(home({ home: computer({ hostKind: 'server', online: true }) })).toEqual({ kind: 'server', online: true })
    for (const [state, online] of [['awake', true], ['asleep', true], ['waking', true], ['provisioning', false], ['error', false]] as const) {
      expect(home({ home: { kind: 'cloud', deviceId: CLOUD }, cloud: { state, deviceId: CLOUD, error: null, since: null } })).toEqual({ kind: 'cloud', online })
    }
    expect(home({ home: { kind: 'cloud', deviceId: CLOUD }, cloud: null })).toEqual({ kind: 'cloud', online: false })
    expect(home({ home: null })).toBeNull()
  })

  it('passes the setup step, preparing, the cloud\'s availability and its failure class — a class, never a message', () => {
    expect(appAssistantStatusOf(snapshot({ setup: 'ready', preparing: true, cloudAvailable: false, loadError: 'network' }), null))
      .toMatchObject({ setup: 'ready', preparing: true, cloudAvailable: false, loadError: 'network' })
    expect(appAssistantStatusOf(snapshot({ loadError: `Error: device ${DEVICE} gone` }), null).loadError).toBe('failed')
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
    publishAssistantShell(snapshot({ deviceCount: 9, ownerName: 'Someone' }))
    await flush()
    expect(push).toHaveBeenCalledOnce()
    publishAssistantShell(snapshot({ deviceCount: 9, ownerName: 'Someone', member: true }))
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
