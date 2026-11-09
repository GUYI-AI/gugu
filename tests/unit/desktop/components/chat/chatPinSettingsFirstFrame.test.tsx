// @vitest-environment jsdom
//
// A group revisited after more than five minutes paints its pinned topic tabs in the first frame: the pins it read
// before are kept, and the read that resumes with the watch replaces them silently.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createNode, createReactHarness, renderWithAppProviders } from '../../../../support/testHarness'
import { useChatPinSettings } from '../../../../../apps/desktop/src/components/chat/useChatPinSettings'
import { queryClient } from '../../../../../apps/desktop/src/session/renderer/lib/query-client'

const pins = vi.hoisted(() => ({ ids: ['t-1'], reads: 0 }))
vi.mock('@/lib/chatPinSettings', () => ({
  readChatPinSettings: async () => { pins.reads++; return { topicIds: [...pins.ids] } },
  setChatPinPreference: vi.fn(),
  watchChatPinSettings: () => () => {},
}))

const firstFrames: string[][] = []
function Pins() {
  const { topicIds } = useChatPinSettings('g-first-frame')
  if (firstFrames.length === 0 || firstFrames.at(-1) !== topicIds) firstFrames.push(topicIds)
  return createNode('span', { 'data-testid': 'pins' }, topicIds.join(','))
}
const shown = () => document.querySelector('[data-testid="pins"]')?.textContent

let harness: ReturnType<typeof createReactHarness>
beforeEach(() => { harness = createReactHarness(); queryClient.clear() })
afterEach(() => { harness.cleanup(); vi.useRealTimers() })

describe('pinned topics of a revisited group', () => {
  it('keeps the last pins for the first frame and re-reads them in the background', async () => {
    await renderWithAppProviders(harness, createNode(Pins, {}), { auth: { id: 'u-1' } })
    await vi.waitFor(() => expect(shown()).toBe('t-1'))
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    harness.cleanup() // the last observer leaves: the query library schedules its collection now
    vi.advanceTimersByTime(6 * 60_000) // past its default five minutes
    vi.useRealTimers()
    pins.ids = ['t-1', 't-2'] // pinned elsewhere while nobody watched this group
    const readsBefore = pins.reads
    firstFrames.length = 0

    harness = createReactHarness()
    await renderWithAppProviders(harness, createNode(Pins, {}), { auth: { id: 'u-1' } })
    expect(firstFrames[0]).toEqual(['t-1'])
    await vi.waitFor(() => expect(shown()).toBe('t-1,t-2'))
    expect(pins.reads).toBe(readsBefore + 1)
  })
})
