// @vitest-environment jsdom
// A task card of mine: which computer this is comes from the local host, ❌ from the account's cloud device list (unread
// or unreadable offline, it made every card open by the "another computer" route).
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const opened = vi.hoisted(() => vi.fn())
vi.mock('../../../../apps/desktop/src/components/chat/openTaskCardSession', () => ({ openTaskCardSession: opened }))
vi.mock('../../../../apps/desktop/src/store/auth', () => ({ useAuth: () => ({ user: { id: 'me' } }) }))
vi.mock('../../../../apps/desktop/src/store/chatContext', () => ({ useChatStore: () => ({ subscribeAccountRevision: () => () => undefined }) }))
vi.mock('../../../../apps/desktop/src/lib/avatarIdentity', () => ({ useAvatarIdentity: () => null }))
vi.mock('../../../../apps/desktop/src/hooks/useAgentDisplayStatus', () => ({ useAgentDisplayStatuses: () => ({}) }))
vi.mock('../../../../apps/desktop/src/hooks/useShownAgentName', () => ({ useShownAgentName: ({ name }: { name: string }) => name }))
vi.mock('../../../../apps/desktop/src/components/AgentHarnessIdentity', () => ({ AgentHarnessIcon: () => null, EngineIcon: () => null }))
vi.mock('../../../../apps/desktop/src/components/Avatar', () => ({ Avatar: () => null }))
// The account's device list cannot be read (offline, or never read on this device).
vi.mock('../../../../apps/desktop/src/store/devicesRead', () => ({ readDevices: async () => { throw new Error('offline') } }))

const { ComposerCardView } = await import('../../../../apps/desktop/src/components/chat/ComposerCardView')
const { followRendererSession, queryClient } = await import('../../../../apps/desktop/src/lib/replica')
const { platform } = await import('../../../../apps/desktop/src/platform')

const card = {
  v: 1, type: 'task', text: 'fix it', agentUserId: 'agent-1', agentName: 'Agent', sessionId: 's-1', projectId: 'p-1',
  deviceId: 'mac', machineLabel: 'Mac',
} as const

let host: HTMLDivElement
let root: Root
let self: () => Promise<unknown>
beforeEach(() => {
  queryClient.clear()
  opened.mockClear()
  followRendererSession('SIGNED_IN', 'me')
  self = async () => ({ device_id: 'mac' })
  platform.getLocalDeviceSelfSnapshot = (() => self()) as never
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
})

const render = () => act(async () => root.render(
  <ComposerCardView card={card} isMine isGroup={false} chatId="dm-1" senderName="Me" time="10:00" />,
))
const cardEl = () => host.querySelector<HTMLElement>('[data-testid="composer-card"]')!

describe('a task card of mine: where it runs', () => {
  it('opens on this computer when the local host says this is the card\'s machine, the device list unreadable', async () => {
    await render()
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    await act(async () => { cardEl().click() })
    expect(opened).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 's-1' }), true)
  })

  it('cannot be opened while this computer is not known yet (❌ opened by the other-computer route)', async () => {
    self = () => new Promise(() => {})
    await render()
    expect(cardEl().dataset.openable).toBeUndefined()
    cardEl().click()
    expect(opened).not.toHaveBeenCalled()
  })
})
