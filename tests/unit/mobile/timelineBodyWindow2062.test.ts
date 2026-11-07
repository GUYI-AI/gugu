import { describe, expect, it, vi } from 'vitest'
import type { SessionpageSessionBodyReadResult, WindowBodyRef } from '@gugu/session-core/session-record/contract'
import { TimelineBodyWindow } from '@/mobile/agent-watch/timeline-body-window'
const ref: WindowBodyRef = { version: 1, scope: 's', sourceLineage: 'l', id: 'body', revision: 'r',
  owner: { kind: 'canonical', turnId: 't', itemId: 'i' }, turnId: 't', itemId: 'i',
  firstChunk: null, decoderCheckpoint: null, sourceRange: { start: 5e9, end: 6e9 }, byteLength: null }
type BodyRead = ConstructorParameters<typeof TimelineBodyWindow>[1]
const io = { sourceBytes: 0, indexBytes: 0, decodedBytes: 0, outputBytes: 0, examinedRecords: 0 }
const page = (offset: number, revision = 'r', text = '猫🙂'): SessionpageSessionBodyReadResult => ({
  kind: 'body', bodyId: 'body', revision, offset, nextOffset: offset + new TextEncoder().encode(text).length,
  previousOffset: offset ? Math.max(0, offset - 16001) : null, moreAfter: 'yes', text, io,
})
describe('bounded current body page', () => {
  it('requests only the selected decoded offset and replaces text rather than collecting a body', async () => {
    const read = vi.fn<BodyRead>(async input => page(input.offset))
    const window = new TimelineBodyWindow('session', read)
    await window.load(ref, 5e9)
    expect(read).toHaveBeenCalledTimes(1)
    expect(read.mock.calls[0]![0]).toMatchObject({ conversationId: 'session', offset: 5e9, maxBytes: 16384 })
    await window.load(ref, window.view.page!.nextOffset)
    expect(window.view.page!.text).toBe('猫🙂')
    expect(window.view.page!.text.length).toBe(3)
  })
  it('uses server previousOffset even after eviction, without retaining all page starts', async () => {
    const read = vi.fn<BodyRead>(async input => page(input.offset, 'r', 'x'.repeat(input.maxBytes)))
    const window = new TimelineBodyWindow('session', read)
    for (let n = 0; n < 6; n++) await window.load(ref, n * 32768)
    const currentOffset = window.view.page!.offset
    const previous = window.view.page!.previousOffset!
    await window.previous(ref)
    expect(read.mock.calls.at(-1)![0]).toMatchObject({ offset: previous, maxBytes: 16001 })
    expect(window.view.page!.nextOffset).toBe(currentOffset)
    await window.load(ref, 0)
    expect(read).toHaveBeenCalledTimes(8) // Page zero was evicted, not made inaccessible.
  })
  it('does not reuse a longer cached page for a Prev request with the same offset', async () => {
    const read = vi.fn<BodyRead>(async input => page(input.offset, 'r', 'x'.repeat(input.maxBytes)))
    const window = new TimelineBodyWindow('session', read)
    await window.load(ref, 0)
    await window.load(ref, 7000)
    await window.previous(ref)
    expect(read).toHaveBeenCalledTimes(3)
    expect(read.mock.calls[2]![0]).toMatchObject({ offset: 0, maxBytes: 7000 })
    expect(window.view.page!.nextOffset).toBe(7000)
  })
  it('rejects a Prev response which stops before the original current-page boundary', async () => {
    const window = new TimelineBodyWindow('session', vi.fn<BodyRead>(async input => page(input.offset)))
    await window.load(ref, 7000)
    await window.previous(ref)
    expect(window.view.phase).toBe('error')
  })
  it('coalesces the same page and ignores a late old-revision response after cancellation', async () => {
    let finish!: (value: SessionpageSessionBodyReadResult) => void
    const read = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
      .mockResolvedValueOnce(page(0, 'new'))
    const window = new TimelineBodyWindow('session', read)
    const old = window.load(ref)
    expect(window.load(ref)).toBe(old)
    const signal = read.mock.calls[0]![1] as AbortSignal
    await window.load({ ...ref, revision: 'new' })
    expect(signal.aborted).toBe(true)
    finish(page(0))
    expect(await old).toBeNull()
    expect(window.view.page!.revision).toBe('new')
  })
  it('keeps needs_location and reset explicit, without a scan-from-zero retry', async () => {
    const read = vi.fn().mockResolvedValueOnce({ kind: 'needs_location', bodyId: 'body', revision: 'r', offset: 40000, io })
      .mockResolvedValueOnce({ kind: 'reset', bodyId: 'body', revision: 'r', reason: 'source_changed', io })
    const window = new TimelineBodyWindow('session', read)
    await window.load(ref, 40000); expect(window.view.phase).toBe('needs_location')
    await window.load(ref, 40000); expect(window.view.phase).toBe('reset')
    expect(read.mock.calls.map(call => call[0].offset)).toEqual([40000, 40000])
  })
  it('rejects another body, invalid byte counts and an incomplete Unicode character', async () => {
    for (const bad of [{ ...page(0), bodyId: 'other' }, { ...page(0), nextOffset: 99 }, page(0, 'r', '\ud800')]) {
      const window = new TimelineBodyWindow('session', vi.fn().mockResolvedValue(bad))
      await window.load(ref)
      expect(window.view.phase).toBe('error')
    }
  })
})
