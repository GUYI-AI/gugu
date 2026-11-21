import { comparer, observable, runInAction } from 'mobx'
import { describe, expect, it } from 'vitest'
import { mobxReadable } from '../../../../apps/desktop/src/lib/mobxReadable'

/** §6's MobX adapter with `equals`: one stable object while the reading is equal (a reader re-renders only on a change). */
describe('mobxReadable with equals', () => {
  it('keeps the same object while the reading is structurally equal, and tells its subscribers only when it changes', () => {
    const tabs = observable({ shown: 'a', other: 0 })
    const readable = mobxReadable(() => ({ shown: tabs.shown }), comparer.structural)
    let told = 0
    const stop = readable.subscribe(() => { told += 1 })
    const first = readable.get()
    runInAction(() => { tabs.other = 1 })
    expect(told).toBe(0)
    expect(readable.get()).toBe(first)
    runInAction(() => { tabs.shown = 'b' })
    expect(told).toBe(1)
    expect(readable.get()).toEqual({ shown: 'b' })
    stop()
    runInAction(() => { tabs.shown = 'c' })
    expect(told).toBe(1)
  })
})
