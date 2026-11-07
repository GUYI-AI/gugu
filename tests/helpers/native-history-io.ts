/** Test-only I/O observation at the production WindowByteSource boundary. No large files are created. */
export type ByteSource<Snapshot = unknown> = {
  snapshot(): Promise<Snapshot>
  read(target: Uint8Array, offset: number, length: number, position: number): Promise<number>
}
export type IoLimits = { bytes: number; buffer: number; earliest: number; calls: number }
export function meteredSource<Snapshot>(source: ByteSource<Snapshot>, limits: IoLimits) {
  let reserved = 0
  const counts = { bytes: 0, requested: 0, peakBuffer: 0, calls: 0, earliest: Infinity }
  const measured: ByteSource<Snapshot> = {
    snapshot: () => source.snapshot(),
    async read(target, offset, length, position) {
      for (const value of [offset, length, position]) {
        if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid read range')
      }
      if (offset + length > target.byteLength) throw new Error('Read outside target')
      if (target.byteLength > limits.buffer) throw new Error('Read buffer exceeds memory bound')
      if (position < limits.earliest) throw new Error('Poison prefix was read')
      if (counts.bytes + reserved + length > limits.bytes) throw new Error('Aggregate read budget exceeded')
      if (counts.calls + 1 > limits.calls) throw new Error('Read call budget exceeded')
      counts.requested += length
      counts.calls++
      counts.peakBuffer = Math.max(counts.peakBuffer, target.byteLength)
      counts.earliest = Math.min(counts.earliest, position)
      reserved += length
      try {
        const count = await source.read(target, offset, length, position)
        if (!Number.isInteger(count) || count < 0 || count > length) throw new Error('Invalid actual read count')
        counts.bytes += count
        return count
      } finally { reserved -= length }
    },
  }
  return { source: measured, counts }
}
/** Sparse bytes are synthesized on demand; only the readable suffix occupies memory. */
export function virtualSparseSource(size: number, suffix: Uint8Array, shortRead = Infinity): ByteSource<{ sourceId: string; generation: string; size: number }> {
  if (!Number.isSafeInteger(size) || size < suffix.length || shortRead <= 0) throw new Error('Invalid sparse fixture')
  return {
    async snapshot() { return { sourceId: 'synthetic-rollout', generation: 'snapshot-1', size } },
    async read(target, offset, length, position) {
      const count = Math.min(length, shortRead, Math.max(0, size - position))
      target.fill(0, offset, offset + count)
      const start = Math.max(position, size - suffix.length)
      const end = Math.min(position + count, size)
      if (end > start) target.set(suffix.subarray(start - size + suffix.length, end - size + suffix.length), offset + start - position)
      return count
    },
  }
}
