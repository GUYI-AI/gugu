import { afterEach, describe, expect, it, vi } from 'vitest'
import { meteredSource, virtualSparseSource } from '../../helpers/native-history-io'
import { createRecentReader } from '../../../packages/session-core/src/session-record/window-cache/recent-reader'
import { createWindowBudget, WindowBudgetExceeded } from '../../../packages/session-core/src/session-record/window-cache/read-budget'

const frame = 65536
function setup(size: number, provider: 'claude' | 'codex') {
  const row = (id: string) => JSON.stringify(provider === 'claude'
    ? { type: 'user', uuid: id, message: { role: 'user', content: id + ' 中文 🐾 " \\' } }
    : { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: id + ' 中文 🐾 " \\' }] } }) + '\n'
  const suffix = new TextEncoder().encode('\n' + row('older') + row('latest'))
  const sparse = virtualSparseSource(size, suffix, 4096)
  const observed = meteredSource({ ...sparse, snapshot: async () => ({ sourceId: 'source', sourceInstance: 'instance', snapshotRevision: 'pinned', size }) },
    { bytes: 512 * 1024, buffer: frame, earliest: size - frame, calls: 512 })
  const close = vi.fn(async () => {})
  const reader = createRecentReader({ openSource: async () => ({ source: observed.source, sourceLineage: 'b'.repeat(64), close }),
    schedulePending: async () => {}, body: { descriptor: async () => null, content: async () => { throw new Error('Unexpected body I/O') } } })
  const request = () => ({ locator: { harness: provider, providerSessionId: 'fixture', roots: [] }, conversationId: 'fixture',
    cacheDirectory: '/unused', scope: 'a'.repeat(64), conversationScope: 'c'.repeat(64), branchLineage: 'd'.repeat(64), limit: 2, budget: createWindowBudget() })
  return { ...observed, reader, request, close }
}
afterEach(() => vi.unstubAllGlobals())

describe('C actual production openRecent budget regression; unresolved content is not paint', () => {
  it.each(['claude', 'codex'] as const)('bounds source bytes and typed-array allocation beyond 2GiB for %s', async provider => {
    for (const size of [10 * 1024 ** 2, 2 ** 31 + 173, 5 * 1024 ** 3, 20 * 1024 ** 3]) {
      const input = setup(size, provider)
      const Native = Uint8Array
      let allocationPeak = 0
      vi.stubGlobal('Uint8Array', new Proxy(Native, { construct(target, args, newTarget) {
        if (typeof args[0] === 'number') {
          if (args[0] > frame) throw new Error('History-sized allocation attempted before read')
          allocationPeak = Math.max(allocationPeak, args[0])
        }
        return Reflect.construct(target, args, newTarget)
      } }))
      const request = input.request()
      const result = await input.reader.openRecent(request)
      expect(result.kind).toBe('page')
      if (result.kind !== 'page') throw new Error('Expected bounded page')
      expect(result.sourceFragments?.map(fragment => fragment.text?.startsWith('latest'))).toEqual([false, true])
      expect(result.turns).toEqual([]) // UI ownership unresolved; not a readable-paint claim.
      expect(result.sourceFragments?.every(fragment => fragment.ownership === 'unresolved')).toBe(true)
      expect(input.counts.bytes).toBe(frame)
      expect(input.counts.peakBuffer).toBe(frame)
      expect(input.counts.earliest).toBe(size - frame)
      expect(allocationPeak).toBe(frame)
      expect(result.io.sourceBytes).toBe(input.counts.bytes)
      expect(result.io.decodedBytes).toBeLessThanOrEqual(frame)
      expect(result.io.outputBytes).toBeLessThanOrEqual(128 * 1024)
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(128 * 1024)
      expect(input.close).toHaveBeenCalledTimes(1)
      vi.unstubAllGlobals()
    }
  })
  it('keeps one aggregate budget across reopen requests and rejects the ninth before actual I/O', async () => {
    const input = setup(2 ** 31 + 173, 'codex'), request = input.request()
    for (let index = 0; index < 8; index++) await input.reader.openRecent(request)
    await expect(input.reader.openRecent(request)).rejects.toBeInstanceOf(WindowBudgetExceeded)
    expect(input.counts.bytes).toBe(512 * 1024)
    expect(request.budget.counters.sourceBytes).toBe(input.counts.bytes)
  })
})
