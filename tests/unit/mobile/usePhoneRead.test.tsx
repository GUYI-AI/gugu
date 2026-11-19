// @vitest-environment jsdom
// #7199
import '../../../apps/desktop/src/i18n/registerAssistantCatalog'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { usePhoneRead, type PhoneRead } from '../../../apps/desktop/src/mobile/assistant/usePhoneRead'
import { createNode, createReactHarness, deferred } from '../../support/testHarness'

// 悄悄重读(语音笔记还在处理时每隔几秒再问一次)偶尔失败一次,不该让它从此不再刷新:
// 否则「处理中」的笔记永远停在处理中(code-review #7277 第 2 条)。
let latest: (PhoneRead<string> & { refresh: () => Promise<void>; reload: () => void }) | null = null
function Probe({ read, pollMs }: { read: () => Promise<string>; pollMs: (data: string) => number | null }) {
  latest = usePhoneRead('key', read, 'test', pollMs)
  return null
}

describe('usePhoneRead polling', () => {
  let harness: ReturnType<typeof createReactHarness>
  beforeEach(() => {
    vi.useFakeTimers()
    harness = createReactHarness()
    latest = null
  })
  afterEach(() => {
    harness.cleanup()
    vi.useRealTimers()
  })

  it('keeps polling after a quiet re-read fails, and keeps the last good read meanwhile', async () => {
    const read = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce('processing')
      .mockRejectedValueOnce(new TypeError('network'))
      .mockResolvedValueOnce('done')
    await harness.render(createNode(Probe, { read, pollMs: (data: string) => (data === 'processing' ? 1000 : null) }))
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(latest).toEqual(expect.objectContaining({ state: 'ok', data: 'processing' }))
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect(read, 'the quiet re-read ran and failed').toHaveBeenCalledTimes(2)
    expect(latest, 'a failed quiet re-read leaves the last read in place').toEqual(expect.objectContaining({ state: 'ok', data: 'processing' }))
    expect(latest).not.toHaveProperty('refreshError')
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect(read, 'polling went on after the failure').toHaveBeenCalledTimes(3)
    expect(latest).toEqual(expect.objectContaining({ state: 'ok', data: 'done' }))
  })

  it('says so when the first read fails (not a quiet one)', async () => {
    const read = vi.fn<() => Promise<string>>().mockRejectedValue(new Error('network'))
    await harness.render(createNode(Probe, { read, pollMs: () => 1000 }))
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(latest?.state).toBe('error')
  })

  it('bounds an unresolved read, ignores its late result and recovers automatically', async () => {
    const hung = deferred<string>()
    const read = vi.fn<() => Promise<string>>().mockReturnValueOnce(hung.promise).mockResolvedValueOnce('recovered')
    await harness.render(createNode(Probe,{ read,pollMs: () => null }))
    await act(async () => { await vi.advanceTimersByTimeAsync(15_001) })
    expect(latest).toMatchObject({ state: 'error',error: { code: 'read-timeout' } })
    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    expect(latest).toMatchObject({ state: 'ok',data: 'recovered' })
    await act(async () => { hung.resolve('stale') })
    expect(latest).toMatchObject({ state: 'ok',data: 'recovered' })
  })

  it.each(['unprepared','collection-unavailable','application-failed','stale'])('does not poll snapshot state %s until an actual change arrives', async code => {
    const read = vi.fn<() => Promise<string>>().mockRejectedValueOnce(Object.assign(new Error('snapshot state'),{ code })).mockResolvedValueOnce('changed')
    await harness.render(createNode(Probe,{ read,pollMs: () => 1000 }))
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    expect(read).toHaveBeenCalledTimes(1)
    // Waiting for a collection being prepared, the read follows once a burst of changes settles (the case below).
    const { WAITING_SETTLE_MS } = await import('../../../apps/desktop/src/components/assistant/useAssistantRead')
    await act(async () => { window.dispatchEvent(new Event('gugu:assistant-panel-changed')); await vi.advanceTimersByTimeAsync(code === 'unprepared' ? WAITING_SETTLE_MS : 0) })
    expect(latest).toMatchObject({ state: 'ok',data: 'changed' })
  })

  it('does not let an earlier poll replace the verified result after a mutation', async () => {
    const poll = deferred<string>()
    const read = vi.fn<() => Promise<string>>()
      .mockResolvedValueOnce('old')
      .mockReturnValueOnce(poll.promise)
      .mockResolvedValueOnce('updated')
    await harness.render(createNode(Probe, { read, pollMs: (data: string) => data === 'old' ? 1000 : null }))
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect(read).toHaveBeenCalledTimes(2)
    await act(async () => { await latest!.refresh() })
    expect(latest).toMatchObject({ state: 'ok', data: 'updated' })
    await act(async () => { poll.resolve('stale') })
    expect(latest).toMatchObject({ state: 'ok', data: 'updated' })
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect(read).toHaveBeenCalledTimes(3)
  })

  it('reports an explicitly requested refresh failure instead of claiming verification succeeded', async () => {
    const read = vi.fn<() => Promise<string>>().mockResolvedValueOnce('old').mockRejectedValueOnce(new Error('verification unavailable'))
    await harness.render(createNode(Probe, { read, pollMs: () => null }))
    await act(async () => { await expect(latest!.refresh()).rejects.toThrow('verification unavailable') })
    expect(latest?.state).toBe('error')
  })

  // Owner 11-12 log (fresh account, desktop): 26 「assistant phone read failed: This collection has not been prepared yet」 in
  // ~6 s — two readers re-reading on every change of the panel while the cloud prepared it. A read waiting for its collection
  // lets a burst of changes settle and reads once, says so once (not a warning per change), and reads again on the next
  // change once its collection is there.
  it('a collection not prepared yet: waits for the changes to settle, reads once per burst, warns never', async () => {
    const { ASSISTANT_PANEL_CHANGED } = await import('../../../apps/desktop/src/components/assistant/assistant-panel-events')
    const { WAITING_SETTLE_MS } = await import('../../../apps/desktop/src/components/assistant/useAssistantRead')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.spyOn(console, 'info').mockImplementation(() => undefined)
    const unprepared = () => Object.assign(new Error('This collection has not been prepared yet'), { code: 'unprepared' })
    const read = vi.fn<() => Promise<string>>().mockImplementation(async () => { throw unprepared() })
    await harness.render(createNode(Probe, { read, pollMs: () => null }))
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(read).toHaveBeenCalledTimes(1)
    expect(latest).toMatchObject({ state: 'error', error: { code: 'unprepared' } })
    // A burst of panel changes while it is prepared: one read once they settle, not one per change; nothing on a timer.
    for (let i = 0; i < 10; i += 1) {
      await act(async () => { window.dispatchEvent(new CustomEvent(ASSISTANT_PANEL_CHANGED)); await vi.advanceTimersByTimeAsync(300) })
    }
    expect(read).toHaveBeenCalledTimes(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(WAITING_SETTLE_MS) })
    expect(read).toHaveBeenCalledTimes(2)
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    expect(read).toHaveBeenCalledTimes(2)
    // Prepared: the next change reads it, and from then on each change reads at once, as before.
    read.mockResolvedValue('ready')
    await act(async () => { window.dispatchEvent(new CustomEvent(ASSISTANT_PANEL_CHANGED)); await vi.advanceTimersByTimeAsync(WAITING_SETTLE_MS) })
    expect(latest).toMatchObject({ state: 'ok', data: 'ready' })
    const reads = read.mock.calls.length
    await act(async () => { window.dispatchEvent(new CustomEvent(ASSISTANT_PANEL_CHANGED)); await vi.advanceTimersByTimeAsync(0) })
    expect(read).toHaveBeenCalledTimes(reads + 1)
    expect(warn.mock.calls.filter((call) => String(call[0]).includes('assistant phone read failed'))).toEqual([])
  })

})

// Explicit reload uses the same reader; it must not replace a known error/data with loading.
it('keeps an error and previous data visible while a reload is unresolved', async () => {
  vi.useFakeTimers()
  const h = createReactHarness()
  try {
    const pending = deferred<string>()
    const read = vi.fn<() => Promise<string>>().mockResolvedValueOnce('saved').mockReturnValueOnce(pending.promise)
    await h.render(createNode(Probe,{ read,pollMs: () => null }))
    await act(async () => { latest!.reload() })
    expect(latest).toMatchObject({ state: 'ok',data: 'saved' })
    await act(async () => { pending.reject(Object.assign(new Error('unprepared'),{ code: 'unprepared' })) })
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    expect(latest).toMatchObject({ state: 'ok',data: 'saved',refreshError: { code: 'unprepared' } })
  } finally { h.cleanup(); vi.useRealTimers() }
})
