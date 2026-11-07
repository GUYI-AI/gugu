// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { Blob as NodeBlob } from 'node:buffer'
import { WidgetSnapshots, widgetSnapshotKey, WIDGET_SNAPSHOT_MAX_BYTES } from '../../../apps/desktop/src/lib/widgetSnapshots'

beforeEach(() => { Object.assign(globalThis, { IDBKeyRange, Blob: NodeBlob }) })
const picture = () => new Blob(['image'], { type: 'image/webp' })
describe('local widget picture account boundaries', () => {
  it('keys pictures by account, identity, theme and 40-pixel width bucket', () => {
    expect(widgetSnapshotKey('a', 'w', 'dark', 400)).toBe(widgetSnapshotKey('a', 'w', 'dark', 439))
    for (const key of [widgetSnapshotKey('b', 'w', 'dark', 400), widgetSnapshotKey('a', 'x', 'dark', 400), widgetSnapshotKey('a', 'w', 'light', 400), widgetSnapshotKey('a', 'w', 'dark', 440)]) {
      expect(key).not.toBe(widgetSnapshotKey('a', 'w', 'dark', 400))
    }
  })
  it('clears the former account and refuses a capture completing after an account switch', async () => {
    const store = new WidgetSnapshots(() => new IDBFactory())
    await store.setAccount('a')
    const capture = store.capture()!
    expect(await store.put(capture, 'w', 'dark', 400, picture())).toBe(true)
    expect(await store.read('w', 'dark', 400)).not.toBeNull()
    await store.setAccount('b')
    expect(await store.put(capture, 'w', 'dark', 400, picture())).toBe(false)
    expect(await store.read('w', 'dark', 400)).toBeNull()
    await store.setAccount('a')
    expect(await store.read('w', 'dark', 400)).toBeNull()
  })
  it('after a restart keeps only the account signing in: the same one finds its pictures, another clears them', async () => {
    const disk = new IDBFactory()
    const first = new WidgetSnapshots(() => disk)
    await first.setAccount('a')
    expect(await first.put(first.capture()!, 'w', 'dark', 400, picture())).toBe(true)
    const again = new WidgetSnapshots(() => disk)
    await again.setAccount('a')
    expect(await again.read('w', 'dark', 400)).not.toBeNull()
    await new WidgetSnapshots(() => disk).setAccount('b')
    const back = new WidgetSnapshots(() => disk)
    await back.setAccount('a')
    expect(await back.read('w', 'dark', 400)).toBeNull()
  })
  it('keeps captures that finish after logout out of storage and rejects oversized or non-WebP data', async () => {
    const store = new WidgetSnapshots(() => new IDBFactory())
    await store.setAccount('a')
    const capture = store.capture()!
    expect(await store.put(capture, 'w', 'dark', 400, new Blob(['x'], { type: 'image/png' }))).toBe(false)
    expect(await store.put(capture, 'w', 'dark', 400, new Blob([new Uint8Array(WIDGET_SNAPSHOT_MAX_BYTES + 1)], { type: 'image/webp' }))).toBe(false)
    const clearing = store.setAccount(null)
    expect(await store.put(capture, 'w', 'dark', 400, picture())).toBe(false)
    await clearing
    expect(await store.read('w', 'dark', 400)).toBeNull()
  })

  it('evicts the least recently used picture when the account exceeds twenty MiB', async () => {
    const store = new WidgetSnapshots(() => new IDBFactory())
    await store.setAccount('a')
    const capture = store.capture()!
    const blob = new Blob([new Uint8Array(WIDGET_SNAPSHOT_MAX_BYTES)], { type: 'image/webp' })
    let time = 0
    const now = vi.spyOn(Date, 'now').mockImplementation(() => ++time)
    try {
      for (let i = 0; i < 102; ++i) expect(await store.put(capture, `w${i}`, 'dark', 400, blob)).toBe(true)
      expect(await store.read('w0', 'dark', 400)).not.toBeNull()
      expect(await store.put(capture, 'w102', 'dark', 400, blob)).toBe(true)
      expect(await store.read('w1', 'dark', 400)).toBeNull()
      expect(await store.read('w0', 'dark', 400)).not.toBeNull()
      expect(await store.read('w102', 'dark', 400)).not.toBeNull()
    } finally { now.mockRestore() }
  })
})
