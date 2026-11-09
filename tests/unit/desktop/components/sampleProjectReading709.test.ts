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
  readSampleProjectShown: vi.fn<(userId: string) => Promise<boolean>>(),
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

function Probe() {
  const sample = useSampleProject()
  return createNode('output', { 'data-shown': String(sample.shown), 'data-settled': String(sample.settled) })
}
let account = 0
beforeEach(() => { key.readSampleProjectShown.mockReset(); owner.ownerId = `account-${++account}` })

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
    key.readSampleProjectShown.mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    const first = createReactHarness()
    await first.render(createNode(Probe))
    expect(first.container.querySelector('output')?.dataset.shown).toBe('true')
    first.cleanup()
    const next = createReactHarness()
    try {
      await next.render(createNode(Probe))
      expect(key.readSampleProjectShown).toHaveBeenCalledTimes(2)
      expect(next.container.querySelector('output')?.dataset).toMatchObject({ shown: 'false', settled: 'true' })
    } finally { next.cleanup() }
  })

  it('ignores a stale visible response after a confirmed removal triggered a fresh read', async () => {
    let finish!: (shown: boolean) => void
    key.readSampleProjectShown.mockReturnValueOnce(new Promise<boolean>((resolve) => { finish = resolve })).mockResolvedValue(false)
    const harness = createReactHarness()
    try {
      await harness.render(createNode(Probe))
      await act(async () => { for (const listener of key.listeners) listener(owner.ownerId) })
      expect(harness.container.querySelector('output')?.dataset).toMatchObject({ shown: 'false', settled: 'true' })
      await act(async () => { finish(true) })
      expect(harness.container.querySelector('output')?.dataset).toMatchObject({ shown: 'false', settled: 'true' })
    } finally { harness.cleanup() }
  })

  it('does not let an old account-tree request replace the new sign-in result', async () => {
    let finish!: (shown: boolean) => void
    key.readSampleProjectShown.mockReturnValueOnce(new Promise<boolean>((resolve) => { finish = resolve })).mockResolvedValue(false)
    const first = createReactHarness()
    await first.render(createNode(Probe))
    first.cleanup()
    const next = createReactHarness()
    try {
      await next.render(createNode(Probe))
      expect(key.readSampleProjectShown).toHaveBeenCalledTimes(2)
      await act(async () => { finish(true) })
      expect(next.container.querySelector('output')?.dataset).toMatchObject({ shown: 'false', settled: 'true' })
    } finally { next.cleanup() }
  })

  it('a failed read leaves it unknown — not settled, so nothing is taken off screen — and reads again later', async () => {
    vi.useFakeTimers()
    key.readSampleProjectShown.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(true)
    const harness = createReactHarness()
    try {
      await harness.render(createNode(Probe))
      await act(async () => { await Promise.resolve() })
      const output = () => harness.container.querySelector('output')!
      expect(output().dataset).toMatchObject({ shown: 'false', settled: 'false' })
      expect(key.readSampleProjectShown).toHaveBeenCalledTimes(1)
      await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })
      expect(key.readSampleProjectShown).toHaveBeenCalledTimes(2)
      expect(output().dataset).toMatchObject({ shown: 'true', settled: 'true' })
    } finally {
      harness.cleanup()
    }
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
