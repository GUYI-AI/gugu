// @vitest-environment jsdom
// #709 示例项目那一个键读不到 ≠ 没有:那一行先不出现、屏上那块不收(收了会存进布局),过一会儿再读;
// 示例是屏上唯一一块、被收掉时回首页,❌ 留一屏空白。
import { act } from 'react'
import { runInAction } from 'mobx'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createNode, createReactHarness } from '../../../support/testHarness'

const key = vi.hoisted(() => {
  const listeners = new Set<(userId: string) => void>()
  return {
  readSampleProject: vi.fn<(userId: string) => Promise<Record<string, unknown> | null>>(),
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

function Probe() {
  const sample = useSampleProject()
  return createNode('output', { 'data-shown': String(sample.shown), 'data-settled': String(sample.settled) })
}
const SHOWN = { version: 1 as const, dismissed: false }
const GONE = { version: 1 as const, dismissed: true }
let account = 0
beforeEach(() => { key.readSampleProject.mockReset(); owner.ownerId = `account-${++account}` })

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
