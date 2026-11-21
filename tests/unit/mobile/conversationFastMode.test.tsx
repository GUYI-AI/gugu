// @vitest-environment jsdom
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import type { SessionpageSessionOptionsWithMenu } from '@main/core/session-timeline/session-model-menu'
import { createReactHarness } from '../../support/testHarness'
import { freshReplicaAccount } from '../../support/replicaAccount'
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

beforeEach(async () => { await freshReplicaAccount('phone-fast-owner'); vi.clearAllMocks(); bridge.read.mockResolvedValue(options()); harness = createReactHarness() })
afterEach(() => harness.cleanup())

describe('phone watch Fast wiring', () => {
  it('uses the host-filtered fact and accepted value through the existing phone host client', async () => {
    await harness.render(<Probe />)
    await vi.waitFor(() => expect(current.props.fastMode).toBe(false))
    const accepted = Promise.withResolvers<SessionpageSessionOptionsWithMenu>()
    bridge.set.mockReturnValue(accepted.promise)
    await act(async () => {
      // A second tap can arrive before the disabled switch has rendered.
      current.props.onFastModeChange?.(true)
      current.props.onFastModeChange?.(true)
    })
    expect(current.fastModePending).toBe(true)
    expect(current.props.fastMode).toBe(false)
    await act(async () => accepted.resolve(options('on')))
    await vi.waitFor(() => expect(current.props.fastMode).toBe(true))
    expect(current.fastModePending).toBe(false)
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
    expect(current.fastModePending).toBe(false)
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
  it.each(['accepted', 'rejected'] as const)('ignores an old session Fast request that is %s after switching chats', async result => {
    const old = Promise.withResolvers<SessionpageSessionOptionsWithMenu>()
    bridge.set.mockReturnValue(old.promise)
    await harness.render(<Probe />)
    await vi.waitFor(() => expect(current.props.fastMode).toBe(false))
    await act(async () => { current.props.onFastModeChange?.(true) })
    expect(current.fastModePending).toBe(true)
    await harness.render(<Probe currentTarget={{ ...target, sessionId: 'other-session' }} />)
    expect(current.fastModePending).toBe(false)
    await vi.waitFor(() => expect(bridge.client).toHaveBeenLastCalledWith({ ...target, sessionId: 'other-session' }))
    await act(async () => {
      if (result === 'accepted') old.resolve(options('on'))
      else old.reject(new Error('old session refused'))
    })
    expect(current.props.fastMode).toBe(false)
    expect(current.props.notice).toBeUndefined()
  })
})
