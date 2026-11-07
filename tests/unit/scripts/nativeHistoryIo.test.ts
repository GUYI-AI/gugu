import { describe, expect, it } from 'vitest'
import { meteredSource, virtualSparseSource } from '../../helpers/native-history-io'

const frame = 64 * 1024
const tail = new TextEncoder().encode('{"role":"user","text":"最新内容：中文/emoji/escape"}\n')
function measured(size = 2 ** 31 + 173, shortRead = Infinity) {
  return meteredSource(virtualSparseSource(size, tail, shortRead), {
    bytes: frame, buffer: frame, earliest: size - frame, calls: 32,
  })
}

describe('history I/O measurement fixture (#2062)', () => {
  it('synthesizes a >2GiB offset using one bounded buffer and counts actual short reads', async () => {
    const size = 2 ** 31 + 173
    const { source, counts } = measured(size, 4096)
    const bytes = new Uint8Array(frame)
    // This exercises the meter, not the production reopen adapter; that is tested with A's entry point.
    expect(await source.read(bytes, 0, frame, size - frame)).toBe(4096)
    expect(counts).toEqual({ bytes: 4096, requested: frame, peakBuffer: frame, calls: 1, earliest: size - frame })
    let read = 4096
    while (read < frame) read += await source.read(bytes, read, frame - read, size - frame + read)
    expect(counts.bytes).toBe(frame)
    expect(counts.requested).toBeGreaterThan(frame)
    expect(bytes.subarray(frame - tail.length)).toEqual(tail)
  })
  it.each([10 * 1024 ** 2, 5 * 1024 ** 3, 20 * 1024 ** 3])('returns an identical suffix at virtual size %i', async size => {
    const { source, counts } = measured(size)
    const bytes = new Uint8Array(frame)
    await source.read(bytes, 0, frame, size - frame)
    expect(bytes.subarray(frame - tail.length)).toEqual(tail)
    expect(counts.bytes).toBe(frame)
    expect(counts.peakBuffer).toBe(frame)
  })
  it('fails before a delegated source can read the prefix or exceed the aggregate budget', async () => {
    const { source } = measured()
    const bytes = new Uint8Array(frame)
    await expect(source.read(bytes, 0, 1, 0)).rejects.toThrow('Poison prefix')
    await source.read(bytes, 0, frame, 2 ** 31 + 173 - frame)
    await expect(source.read(bytes, 0, 1, 2 ** 31 + 172)).rejects.toThrow('Aggregate read budget')
  })
  it('rejects a history-sized read buffer and invalid offsets', async () => {
    const { source } = measured()
    await expect(source.read(new Uint8Array(frame + 1), 0, 1, 2 ** 31)).rejects.toThrow('memory bound')
    await expect(source.read(new Uint8Array(1), 0, 1, -1)).rejects.toThrow('Invalid read range')
  })
})
