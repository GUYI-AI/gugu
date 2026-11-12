// @vitest-environment jsdom
// #709 示例项目那一个键读不到 ≠ 没有:那一行先不出现、屏上那块不收(收了会存进布局),过一会儿再读;
// 示例是屏上唯一一块、被收掉时回首页,❌ 留一屏空白。
import { act } from 'react'
import { runInAction } from 'mobx'
import { observer } from 'mobx-react-lite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createNode, createReactHarness } from '../../../support/testHarness'

const key = vi.hoisted(() => {
  const listeners = new Set<(userId: string) => void>()
  return {
  readSampleProject: vi.fn<(userId: string) => Promise<Record<string, unknown> | null>>(),
  dismissSampleProject: vi.fn<(userId: string) => Promise<void>>(),
  listeners,
  subscribeSampleProject: (listener: (userId: string) => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
  }
})
const owner = vi.hoisted(() => ({ ownerId: 'u1', ownerName: 'Ana', ownerAvatar: null }))
vi.mock('../../../../apps/desktop/src/lib/sampleProject', () => key)
vi.mock('../../../../apps/desktop/src/session/renderer/features/assistant/assistant-shell', () => ({
  useAssistantShell: () => owner,
}))

const { useSampleProject } = await import('../../../../apps/desktop/src/session/renderer/features/sample-project/use-sample-project')
const { screenLayout } = await import('../../../../apps/desktop/src/session/renderer/app/screen-layout')
const { forgetSampleProjectOnScreen } = await import('../../../../apps/desktop/src/session/renderer/app/screen-layout-actions')
const { appState } = await import('../../../../apps/desktop/src/session/renderer/lib/stores/app-state')
const { accountProjectsStore } = await import('../../../../apps/desktop/src/session/renderer/features/projects/stores/account-projects-store')
const { resetSampleConversion, sampleConversion } = await import('../../../../apps/desktop/src/session/renderer/features/sample-project/sample-conversion')
const { publishSidebarChatSignals } = await import('../../../../apps/desktop/src/lib/sidebarChatsBridge')

/** What the shell publishes from its chat list: the group chats it draws as rows (null = not loaded yet). */
const chatList = (listedGroups: string[] | null) => act(async () => {
  publishSidebarChatSignals({ chatsUnread: 0, groupUnread: new Map(), groupCallingTopic: new Map(), listedGroups: listedGroups && new Set(listedGroups) })
  await Promise.resolve()
})

// Every caller is an observer (useSampleProject reads the account project list from mobx), so the probe is one too.
const Probe = observer(function Probe() {
  const sample = useSampleProject()
  return createNode('output', { 'data-shown': String(sample.shown), 'data-settled': String(sample.settled) })
})
const SHOWN = { version: 1 as const, dismissed: false }
const GONE = { version: 1 as const, dismissed: true }
let account = 0
beforeEach(() => {
  key.readSampleProject.mockReset()
  key.dismissSampleProject.mockReset().mockResolvedValue(undefined)
  resetSampleConversion()
  publishSidebarChatSignals({ chatsUnread: 0, groupUnread: new Map(), groupCallingTopic: new Map(), listedGroups: new Set() })
  owner.ownerId = `account-${++account}`
})

afterEach(() => {
  vi.useRealTimers()
  runInAction(() => {
    screenLayout.layout = null
    screenLayout.blocks.clear()
    screenLayout.parked.clear()
    screenLayout.focusedBlockId = null
    screenLayout.lastSessionBlockId = null
    appState.navigation.viewParamsStore = {}
  })
})

describe('reading whether this account has the sample (#709)', () => {
  it('reads the persisted choice again when the same account signs back in', async () => {
    key.readSampleProject.mockResolvedValueOnce(SHOWN).mockResolvedValueOnce(GONE)
    const first = createReactHarness()
    await first.render(createNode(Probe))
    expect(first.container.querySelector('output')?.dataset.shown).toBe('true')
    first.cleanup()
    const next = createReactHarness()
    try {
      await next.render(createNode(Probe))
      expect(key.readSampleProject).toHaveBeenCalledTimes(2)
      expect(next.container.querySelector('output')?.dataset).toMatchObject({ shown: 'false', settled: 'true' })
    } finally { next.cleanup() }
  })

  it('ignores a stale visible response after a confirmed removal triggered a fresh read', async () => {
    let finish!: (state: typeof SHOWN) => void
    key.readSampleProject.mockReturnValueOnce(new Promise((resolve) => { finish = resolve })).mockResolvedValue(GONE)
    const harness = createReactHarness()
    try {
      await harness.render(createNode(Probe))
      await act(async () => { for (const listener of key.listeners) listener(owner.ownerId) })
      expect(harness.container.querySelector('output')?.dataset).toMatchObject({ shown: 'false', settled: 'true' })
      await act(async () => { finish(SHOWN) })
      expect(harness.container.querySelector('output')?.dataset).toMatchObject({ shown: 'false', settled: 'true' })
    } finally { harness.cleanup() }
  })

  it('does not let an old account-tree request replace the new sign-in result', async () => {
    let finish!: (state: typeof SHOWN) => void
    key.readSampleProject.mockReturnValueOnce(new Promise((resolve) => { finish = resolve })).mockResolvedValue(GONE)
    const first = createReactHarness()
    await first.render(createNode(Probe))
    first.cleanup()
    const next = createReactHarness()
    try {
      await next.render(createNode(Probe))
      expect(key.readSampleProject).toHaveBeenCalledTimes(2)
      await act(async () => { finish(SHOWN) })
      expect(next.container.querySelector('output')?.dataset).toMatchObject({ shown: 'false', settled: 'true' })
    } finally { next.cleanup() }
  })

  it('a failed read leaves it unknown — not settled, so nothing is taken off screen — and reads again later', async () => {
    vi.useFakeTimers()
    key.readSampleProject.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(SHOWN)
    const harness = createReactHarness()
    try {
      await harness.render(createNode(Probe))
      await act(async () => { await Promise.resolve() })
      const output = () => harness.container.querySelector('output')!
      expect(output().dataset).toMatchObject({ shown: 'false', settled: 'false' })
      expect(key.readSampleProject).toHaveBeenCalledTimes(1)
      await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })
      expect(key.readSampleProject).toHaveBeenCalledTimes(2)
      expect(output().dataset).toMatchObject({ shown: 'true', settled: 'true' })
    } finally {
      harness.cleanup()
    }
  })
})

describe('the sample giving way to the project it became (#2569)', () => {
  afterEach(() => runInAction(() => { accountProjectsStore.list = [] }))

  it('keeps showing until that project is on the account list, then gives way', async () => {
    key.readSampleProject.mockResolvedValue({ version: 2, dismissed: false, projectId: 'p1', chatId: 'chat-became' })
    const harness = createReactHarness()
    try {
      await harness.render(createNode(Probe))
      const output = () => harness.container.querySelector('output')!
      expect(output().dataset).toMatchObject({ shown: 'true', settled: 'true' })
      await act(async () => {
        runInAction(() => { accountProjectsStore.list = [{ chatId: 'chat-became', name: '周末去杭州', archived: false, bindings: [] }] as never })
        await Promise.resolve()
      })
      expect(output().dataset).toMatchObject({ shown: 'false', settled: 'true' })
    } finally { harness.cleanup() }
  })

  // #2589 the project's row is drawn from the chat list (its group) or the account list; the sample reads the same two.
  it('this window\'s conversion gives way in the update that first draws its group in the chat list, still working', async () => {
    key.readSampleProject.mockResolvedValue(SHOWN)
    runInAction(() => Object.assign(sampleConversion, { owner: owner.ownerId, status: 'working', failure: null, chatId: 'chat-new' }))
    const harness = createReactHarness()
    try {
      await harness.render(createNode(Probe))
      const output = () => harness.container.querySelector('output')!
      expect(output().dataset.shown).toBe('true')
      await chatList(['chat-other'])
      expect(output().dataset.shown).toBe('true')
      await chatList(['chat-other', 'chat-new'])
      expect(output().dataset.shown, 'gone in the same update as the row arrives').toBe('false')
    } finally { harness.cleanup() }
  })

  it('nothing is drawn before the chat list has loaded, so the sample does not give way to a row that is not there', async () => {
    key.readSampleProject.mockResolvedValue({ version: 2, dismissed: false, projectId: 'p1', chatId: 'chat-became' })
    await chatList(null)
    const harness = createReactHarness()
    try {
      await harness.render(createNode(Probe))
      await listed('chat-became')
      expect(harness.container.querySelector('output')?.dataset.shown).toBe('true')
      await chatList([])
      expect(harness.container.querySelector('output')?.dataset.shown).toBe('false')
    } finally { harness.cleanup() }
  })

  it('a fresh read keeps what it had while it reads: the row does not blink out', async () => {
    let finish!: (state: typeof SHOWN) => void
    key.readSampleProject.mockResolvedValueOnce(SHOWN).mockReturnValueOnce(new Promise((resolve) => { finish = resolve }))
    const harness = createReactHarness()
    try {
      await harness.render(createNode(Probe))
      await act(async () => { for (const listener of key.listeners) listener(owner.ownerId) })
      expect(harness.container.querySelector('output')?.dataset).toMatchObject({ shown: 'true', settled: 'true' })
      await act(async () => { finish(SHOWN) })
      expect(key.readSampleProject).toHaveBeenCalledTimes(2)
    } finally { harness.cleanup() }
  })

  const listed = (...chatIds: string[]) => act(async () => {
    runInAction(() => { accountProjectsStore.list = chatIds.map((chatId) => ({ chatId, name: chatId, archived: false, bindings: [] })) as never })
    await Promise.resolve()
  })

  // #2589 review 5: the dismissal must not hang on the hand-off alone.
  it('a key that became a listed project but was never dismissed (failed dismissal, reload) is dismissed here', async () => {
    key.readSampleProject.mockResolvedValue({ version: 2, dismissed: false, projectId: 'p1', chatId: 'chat-became' })
    const harness = createReactHarness()
    try {
      await harness.render(createNode(Probe))
      expect(key.dismissSampleProject).not.toHaveBeenCalled()
      await listed('chat-became')
      expect(key.dismissSampleProject).toHaveBeenCalledOnce()
      expect(key.dismissSampleProject).toHaveBeenCalledWith(owner.ownerId)
    } finally { harness.cleanup() }
  })

  it('not while this window is still turning it into a project, or stopped half-way with the message in the box', async () => {
    key.readSampleProject.mockResolvedValue({ version: 2, dismissed: false, projectId: 'p1', chatId: 'chat-became' })
    runInAction(() => Object.assign(sampleConversion, { owner: owner.ownerId, status: 'idle', failure: { kind: 'row' }, chatId: null }))
    const harness = createReactHarness()
    try {
      await harness.render(createNode(Probe))
      await listed('chat-became')
      expect(key.dismissSampleProject).not.toHaveBeenCalled()
      expect(harness.container.querySelector('output')?.dataset.shown, 'the box with the message stays').toBe('true')
    } finally { harness.cleanup() }
  })

  // #2589 review 6
  it('re-reads the key only when the project list gains a project and the key has not recorded one yet', async () => {
    key.readSampleProject.mockResolvedValue(SHOWN)
    const harness = createReactHarness()
    try {
      await harness.render(createNode(Probe))
      expect(key.readSampleProject).toHaveBeenCalledTimes(1)
      await listed('chat-a')
      expect(key.readSampleProject, 'gained a project').toHaveBeenCalledTimes(2)
      await act(async () => {
        runInAction(() => { accountProjectsStore.list = [{ chatId: 'chat-a', name: 'renamed', archived: false, bindings: [] }] as never })
        await Promise.resolve()
      })
      await listed()
      expect(key.readSampleProject, 'a rename or a removal is not a reason to read the account').toHaveBeenCalledTimes(2)
      key.readSampleProject.mockResolvedValue({ version: 2, dismissed: false, projectId: 'p1', chatId: 'chat-became' })
      await listed('chat-b')
      expect(key.readSampleProject).toHaveBeenCalledTimes(3)
      await listed('chat-b', 'chat-c')
      expect(key.readSampleProject, 'the key already says what it became').toHaveBeenCalledTimes(3)
    } finally { harness.cleanup() }
  })
})

describe('taking the sample off screen (#709)', () => {
  it('goes home when it was the only block and there is no session to put back', () => {
    screenLayout.show({ kind: 'sample-project' })
    appState.navigation.navigate('screen')
    forgetSampleProjectOnScreen()
    expect(screenLayout.layout).toBeNull()
    expect(appState.navigation.currentViewId).toBe('home')
  })
})
