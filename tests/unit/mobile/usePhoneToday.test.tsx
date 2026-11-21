// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { assistantToday } from '../../../apps/desktop/src/mobile/assistant/assistantToday'
import { TODAY_REFRESH_MS, type TodayRead } from '../../../apps/desktop/src/session/renderer/features/assistant/assistant-today-file'
import type { Reading } from '../../../apps/desktop/src/lib/replica'
import { createNode, createReactHarness, deferred } from '../../support/testHarness'
import { followRendererSession, queryClient, retryOf, useReplica } from '../../../apps/desktop/src/lib/replica'

const mocks = vi.hoisted(() => ({ read: vi.fn() }))
vi.mock('../../../apps/desktop/src/lib/chatFolder', () => ({ readChatFolderText: mocks.read }))

let latest: Reading<TodayRead> | null = null
function Probe({ chatId }: { chatId: string }) {
  latest = useReplica(assistantToday, [chatId])
  return null
}
const file = (title: string) => ({ text: JSON.stringify({ version: 1, widgets: [{ id: title, title }] }), updatedAt: title })

describe('phone Today reads', () => {
  let harness: ReturnType<typeof createReactHarness>
  beforeEach(() => {
    vi.useFakeTimers()
    queryClient.clear()
    followRendererSession('SIGNED_IN', 'owner')
    mocks.read.mockReset()
    harness = createReactHarness()
    latest = null
  })
  afterEach(() => { harness.cleanup(); vi.useRealTimers() })

  it('hides the previous chat immediately and ignores its late response', async () => {
    const old = deferred<ReturnType<typeof file>>()
    const current = deferred<ReturnType<typeof file>>()
    mocks.read.mockResolvedValueOnce(file('old')).mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise)
    await harness.render(createNode(Probe, { chatId: 'one' }))
    expect(latest).toMatchObject({ state: 'value', value: { state: 'ok', updatedAt: 'old' } })
    await act(async () => { await vi.advanceTimersByTimeAsync(TODAY_REFRESH_MS) })
    await harness.render(createNode(Probe, { chatId: 'two' }))
    expect(latest).toMatchObject({ state: 'unknown' })
    await act(async () => { old.resolve(file('late old')) })
    expect(latest).toMatchObject({ state: 'unknown' })
    await act(async () => { current.resolve(file('new')) })
    expect(latest).toMatchObject({ state: 'value', value: { state: 'ok', updatedAt: 'new' } })
  })

  it('does not overlap a slow initial read or a slow poll', async () => {
    const first = deferred<ReturnType<typeof file>>()
    const second = deferred<ReturnType<typeof file>>()
    mocks.read.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    await harness.render(createNode(Probe, { chatId: 'one' }))
    await act(async () => { await vi.advanceTimersByTimeAsync(TODAY_REFRESH_MS * 3) })
    expect(mocks.read).toHaveBeenCalledTimes(1)
    await act(async () => { first.resolve(file('one')) })
    await act(async () => { await vi.advanceTimersByTimeAsync(TODAY_REFRESH_MS * 3) })
    expect(mocks.read).toHaveBeenCalledTimes(2)
    expect(latest).toMatchObject({ state: 'value', value: { updatedAt: 'one' } })
  })

  it('shows read failures and lets retry recover without treating them as empty', async () => {
    mocks.read.mockRejectedValueOnce(new Error('file service unavailable')).mockResolvedValueOnce(null)
    await harness.render(createNode(Probe, { chatId: 'one' }))
    expect(latest).toMatchObject({ state: 'error' })
    await act(async () => { retryOf(latest!)!() })
    expect(latest).toMatchObject({ state: 'value', value: { state: 'none' } })
  })

  it('E-4: a refresh that fails keeps the ideas read before and says it failed (❌ the old file silently as current)', async () => {
    mocks.read.mockResolvedValueOnce(file('morning')).mockRejectedValueOnce(new Error('file service unavailable'))
    await harness.render(createNode(Probe, { chatId: 'one' }))
    await act(async () => { await vi.advanceTimersByTimeAsync(TODAY_REFRESH_MS) })
    expect(latest).toMatchObject({ state: 'value', value: { state: 'ok', updatedAt: 'morning' }, error: { message: 'file service unavailable' } })
  })
})
