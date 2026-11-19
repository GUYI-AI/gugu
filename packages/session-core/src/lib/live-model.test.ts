import { ok } from '@gugu/session-shared'
import { describe, expect, it, vi } from 'vitest'
import { LiveModel } from './live-model'

function pending() {
  let resolve!: (value: number) => void
  const value = new Promise<number>((done) => {
    resolve = done
  })
  return { value, resolve }
}

describe('LiveModel concurrent reads', () => {
  it('shares the initial computation across subscribers and snapshot reads', async () => {
    const first = pending()
    const compute = vi.fn(async () => ok(await first.value))
    const model = new LiveModel({ compute })
    const updates: number[] = []
    const off = model.subscribe((update) => updates.push(update.value))
    const offSecond = model.subscribe(() => {})
    const reads = Array.from({ length: 30 }, () => model.get())
    first.resolve(1)
    try {
      expect((await Promise.all(reads)).map((read) => read.value)).toEqual(Array(30).fill(1))
      expect(compute).toHaveBeenCalledTimes(1)
      expect(updates).toEqual([1])
    } finally {
      offSecond()
      off()
      model.dispose()
    }
  })

  it('recomputes when an in-flight read is invalidated', async () => {
    const first = pending()
    const compute = vi
      .fn()
      .mockImplementationOnce(async () => ok(await first.value))
      .mockImplementationOnce(async () => ok(2))
    const model = new LiveModel<number>({ compute })
    const initial = model.get()
    model.invalidate()
    const fresh = model.get()
    first.resolve(1)
    try {
      expect((await initial).value).toBe(1)
      expect((await fresh).value).toBe(2)
      expect(compute).toHaveBeenCalledTimes(2)
    } finally {
      model.dispose()
    }
  })

  it('preserves an explicit refresh and joins its queued result', async () => {
    const first = pending()
    const compute = vi
      .fn()
      .mockImplementationOnce(async () => ok(await first.value))
      .mockImplementationOnce(async () => ok(2))
    const model = new LiveModel<number>({ compute })
    const initial = model.get()
    const refresh = model.refresh()
    const read = model.get()
    first.resolve(1)
    try {
      expect((await initial).value).toBe(1)
      expect((await refresh).value).toBe(2)
      expect((await read).value).toBe(2)
      expect(compute).toHaveBeenCalledTimes(2)
    } finally {
      model.dispose()
    }
  })
})
