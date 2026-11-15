// @vitest-environment jsdom
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import type { SessionpageSessionOptionsWithMenu } from '@main/core/session-timeline/session-model-menu'
import { createReactHarness } from '../../support/testHarness'
import { useConversationOptions, type ConversationTarget } from '@/components/chat/useConversationOptions'

const bridge = vi.hoisted(() => ({ read: vi.fn(), set: vi.fn(), client: vi.fn() }))
vi.mock('@/components/assistant/assistantTimelineClient', () => ({
  conversationOptionClient: (target: ConversationTarget) => {
    bridge.client(target)
    return { read: bridge.read, set: bridge.set }
  },
}))
const options = (selected: 'on' | 'off' = 'off'): SessionpageSessionOptionsWithMenu => ({
  mode: null, model: null, effort: null,
  fast: { selected, available: [{ id: 'off', name: 'Off' }, { id: 'on', name: 'On' }] },
})
const target = { deviceId: 'phone-fast', sessionId: 'conv-fast', local: false, phoneHost: true }
let harness: ReturnType<typeof createReactHarness>
let current: ReturnType<typeof useConversationOptions>
function Probe({ currentTarget = target }: { currentTarget?: ConversationTarget }) {
  current = useConversationOptions(currentTarget, 'Codex')
  return <div>{String(current.props.fastMode)}</div>
}

beforeEach(() => { vi.clearAllMocks(); bridge.read.mockResolvedValue(options()); harness = createReactHarness() })
afterEach(() => harness.cleanup())

describe('phone watch Fast wiring', () => {
  it('uses the host-filtered fact and accepted value through the existing phone host client', async () => {
    await harness.render(<Probe />)
    await vi.waitFor(() => expect(current.props.fastMode).toBe(false))
    bridge.set.mockResolvedValue(options('on'))
    await act(async () => { current.props.onFastModeChange?.(true) })
    await vi.waitFor(() => expect(current.props.fastMode).toBe(true))
    expect(bridge.client).toHaveBeenLastCalledWith(target)
    expect(bridge.set).toHaveBeenCalledExactlyOnceWith('fast', 'on')
  })
  it('keeps the old accepted value and exposes the existing failure notice when a change fails', async () => {
    await harness.render(<Probe />)
    await vi.waitFor(() => expect(current.props.fastMode).toBe(false))
    bridge.set.mockRejectedValue(new Error('host refused Fast'))
    await act(async () => { current.props.onFastModeChange?.(true) })
    await vi.waitFor(() => expect(current.props.notice).toBeDefined())
    expect(current.props.fastMode).toBe(false)
    expect(bridge.set).toHaveBeenCalledExactlyOnceWith('fast', 'on')
  })
  it('hides Fast when the host has no eligible group', async () => {
    bridge.read.mockResolvedValue({ ...options(), fast: null })
    await harness.render(<Probe />)
    await vi.waitFor(() => expect(bridge.read).toHaveBeenCalled())
    expect(current.props.fastMode).toBeUndefined()
    expect(bridge.set).not.toHaveBeenCalled()
  })
  it('does not carry an enabled choice into another session', async () => {
    bridge.read.mockResolvedValue(options('on'))
    await harness.render(<Probe />)
    await vi.waitFor(() => expect(current.props.fastMode).toBe(true))
    bridge.read.mockResolvedValue(options('off'))
    await harness.render(<Probe currentTarget={{ ...target, sessionId: 'other-session' }} />)
    await vi.waitFor(() => expect(current.props.fastMode).toBe(false))
    expect(bridge.set).not.toHaveBeenCalled()
  })
})
