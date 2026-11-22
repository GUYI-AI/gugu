// @vitest-environment jsdom
// @@@1647 回归:RemoteFolderPicker 的 elapsed 计时器必须在卸载时清。
// 原 flaky:loading 中(fetch 永不 settle → fetchPath 的 finally 永不到)卸载 → interval 仍 tick →
// setLoadElapsed on unmounted → 测试 env 拆除时 `window is not defined`,随机污染全员 CI(咬过 #1646)。
// 修复 = useEffect cleanup 卸载即 clearInterval(不依赖 async finally)。本测试锁:卸载后无遗留计时器。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
const listMock = vi.fn()
vi.mock('../../../../apps/desktop/src/lib/deviceFs', () => ({
  deviceFsListDirectory: (...args: unknown[]) => listMock(...args),
}))
import { RemoteFolderPicker } from '../../../../apps/desktop/src/components/RemoteFolderPicker'
import { followRendererSession, queryClient } from '../../../../apps/desktop/src/lib/replica'
let container: HTMLDivElement
let root: Root
beforeEach(() => {
  queryClient.clear()
  followRendererSession('SIGNED_IN', 'tester')
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  listMock.mockReset()
})
afterEach(() => {
  container.remove()
  vi.restoreAllMocks()
  vi.useRealTimers()
})
describe('#1647 RemoteFolderPicker elapsed 计时器卸载清理', () => {
  it('loading 中卸载 → elapsed interval 被清,无遗留计时器(不再 setState on unmounted)', async () => {
    vi.useFakeTimers()
    const intervals = new Set<unknown>()
    const setIntervalReal = globalThis.setInterval
    const clearIntervalReal = globalThis.clearInterval
    vi.spyOn(globalThis, 'setInterval').mockImplementation(((handler: () => void, ms?: number) => {
      const id = setIntervalReal(handler, ms)
      intervals.add(id)
      return id
    }) as typeof setInterval)
    vi.spyOn(globalThis, 'clearInterval').mockImplementation(((id: Parameters<typeof clearInterval>[0]) => {
      intervals.delete(id)
      clearIntervalReal(id)
    }) as typeof clearInterval)
    listMock.mockReturnValueOnce(new Promise(() => {})) // 永不 resolve:loading,interval 运行,finally 永不到
    await act(async () => {
      root.render(createElement(RemoteFolderPicker, { deviceId: 'dev-leak', initialPath: '~', onSelect: vi.fn() }))
    })
    // loading 态:elapsed interval(1s)在跑。The listing is a replica read, whose cache keeps its own (gc) timers after
    // unmount: what must be gone is this component's interval, so intervals are counted, ❌ every timer.
    expect(intervals.size, 'loading 时 elapsed interval 应在跑').toBeGreaterThan(0)
    act(() => { root.unmount() })
    // 修复点:卸载即 clearInterval → 无遗留 interval。修复前此处仍为 >0(interval 未清 → 后续 tick 污染 CI)。
    expect(intervals.size, '卸载后 elapsed interval 应被清').toBe(0)
    // 再推进时间也不应触发任何已卸载组件的 setState(不抛)。
    expect(() => act(() => { vi.advanceTimersByTime(5000) })).not.toThrow()
  })
})
