// 主窗口自己数的卡顿:长动画帧(>= 50 ms)与慢交互(>= 100 ms,同一次交互的几个事件只算一次)。
import { describe, expect, it } from 'vitest'
import { installFrameCounters, readFrameCounters } from '../../../apps/desktop/src/lib/frameCounters'

type Callback = (list: { getEntries: () => unknown[] }) => void
const observers = new Map<string, Callback>()
class FakeObserver {
  static supportedEntryTypes = ['long-animation-frame', 'event']
  constructor(private callback: Callback) {}
  observe({ type }: { type: string }) { observers.set(type, this.callback) }
}
const emit = (type: string, entries: unknown[]) => observers.get(type)!({ getEntries: () => entries })

describe('frame counters', () => {
  it('counts long frames and slow interactions cumulatively, once per interaction, and installs once', () => {
    const win = { PerformanceObserver: FakeObserver } as unknown as typeof globalThis
    installFrameCounters(win)
    installFrameCounters(win)
    expect(readFrameCounters()).toEqual({ longFrames: 0, blockingMs: 0, slowInteractions: 0 })
    emit('long-animation-frame', [{ blockingDuration: 30.4 }, { blockingDuration: 0 }])
    emit('event', [
      { interactionId: 7, duration: 180 }, { interactionId: 7, duration: 176 }, // pointerdown + click of one tap
      { interactionId: 8, duration: 60 }, // fast
      { interactionId: 0, duration: 400 }, // not an interaction (e.g. mousemove)
      { interactionId: 9, duration: 120 },
    ])
    expect(readFrameCounters()).toEqual({ longFrames: 2, blockingMs: 30, slowInteractions: 2 })
  })
})
