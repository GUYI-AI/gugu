// @vitest-environment jsdom
// #7350 关闭咕咕的确认框:先唤醒 / 复核它的家(命令),再读它开过哪些会话(读数),确认时关的就是人看到的那一份。
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CloseSession } from '../../../../apps/desktop/src/lib/assistantClose'
import { createNode, createReactHarness, renderWithAppProviders, waitForCondition } from '../../../support/testHarness'

const GUGU = 'agent-gugu'
const session = (conversationId: string, extra: Record<string, unknown> = {}) =>
  ({ conversationId, projectId: 'p1', title: conversationId, agent: null, parentConversationId: null, spawnedByConversationId: null, ...extra }) as CloseSession

const rig = vi.hoisted(() => ({
  home: null as unknown,
  sessionsList: vi.fn(),
  close: vi.fn(async () => undefined),
  wake: vi.fn(),
}))
vi.mock('../../../../apps/desktop/src/lib/useAssistantHome', () => ({
  useAssistantHome: () => ({ contact: { id: 'agent-gugu', display_name: '咕咕' }, home: rig.home }),
}))
vi.mock('@renderer/lib/ipc', async (original) => ({ ...await original<object>(), rpcOn: () => ({ sessionTimeline: { sessionsList: rig.sessionsList } }) }))
vi.mock('@gugu/core/cloud/cloudComputer', async (original) => ({ ...await original<object>(), wakeCloudComputerUntilOnline: rig.wake }))
vi.mock('../../../../apps/desktop/src/lib/cloudComputerClient', () => ({
  rendererCloudComputerClient: () => ({ prepareAssistantClose: async () => undefined, closeAssistant: async () => undefined }),
}))
vi.mock('../../../../apps/desktop/src/lib/myAssistant', () => ({ myAssistant: { refresh: async () => undefined, peek: () => ({ state: 'unknown' }) } }))
vi.mock('../../../../apps/desktop/src/lib/assistantClose', async (original) => ({
  ...await original<object>(),
  closeLocalAssistant: rig.close,
}))

const { AssistantCloseHost } = await import('../../../../apps/desktop/src/components/assistant/AssistantCloseHost')
const { UI_EVENTS } = await import('../../../../apps/desktop/src/lib/uiEvents')

let harness: ReturnType<typeof createReactHarness>
beforeEach(() => { harness = createReactHarness(); vi.clearAllMocks() })
afterEach(() => { harness.cleanup() })

const dialog = () => document.body.querySelector('[data-testid="assistant-close-dialog"]')
const confirmButton = () => document.body.querySelector('[data-testid="assistant-close-confirm"]') as HTMLButtonElement | null
const requestClose = () => act(async () => { window.dispatchEvent(new CustomEvent(UI_EVENTS.closeAssistant)) })
const shownSessions = () => [...(dialog()?.querySelectorAll('.truncate') ?? [])].map((row) => row.textContent)

describe('the close confirmation reads the sessions it will act on', () => {
  it('shows the sessions it started and closes exactly that plan, without reading again at the click', async () => {
    rig.home = { kind: 'computer', hostKind: 'desktop', thisDevice: true, deviceId: 'this', label: null, online: true, known: true }
    rig.sessionsList.mockResolvedValueOnce({ sessions: [session('s-gugu', { agent: { userId: GUGU } }), session('s-child', { spawnedByConversationId: 's-gugu' })] })
      .mockResolvedValue({ sessions: [session('s-gugu', { agent: { userId: GUGU } }), session('s-child', { spawnedByConversationId: 's-gugu' }), session('s-late', { spawnedByConversationId: 's-gugu' })] })
    await renderWithAppProviders(harness, createNode(AssistantCloseHost), { contacts: {} })
    await requestClose()
    await waitForCondition(() => shownSessions().includes('s-child'), 'started sessions not shown')
    expect(confirmButton()?.disabled).toBe(false)
    await act(async () => { confirmButton()!.click() })
    expect(rig.close).toHaveBeenCalledOnce()
    const [input, plan] = rig.close.mock.calls[0] as unknown as [{ assistantId: string; deleteStarted: boolean }, { own: CloseSession[]; started: CloseSession[] }]
    expect(input).toEqual({ assistantId: GUGU, deleteStarted: false })
    expect(plan.started.map((s) => s.conversationId)).toEqual(['s-child'])
    expect(plan.own.map((s) => s.conversationId)).toEqual(['s-gugu'])
    expect(rig.sessionsList).toHaveBeenCalledOnce()
  })

  it('wakes the cloud home before listing; a home that cannot be woken is said and nothing is listed or closable', async () => {
    rig.home = { kind: 'cloud', deviceId: 'cloud-1' }
    rig.wake.mockResolvedValue('offline')
    await renderWithAppProviders(harness, createNode(AssistantCloseHost), { contacts: {} })
    await requestClose()
    await waitForCondition(() => !!dialog()?.querySelector('[role="alert"]'), 'failure not said')
    expect(rig.wake).toHaveBeenCalledOnce()
    expect(rig.sessionsList).not.toHaveBeenCalled()
    expect(confirmButton()?.disabled).toBe(true)
  })

  it('a session list that cannot be read is said, and confirm stays off (never closes on an empty list)', async () => {
    rig.home = { kind: 'computer', hostKind: 'desktop', thisDevice: true, deviceId: 'this', label: null, online: true, known: true }
    rig.sessionsList.mockRejectedValue(new Error('host gone'))
    await renderWithAppProviders(harness, createNode(AssistantCloseHost), { contacts: {} })
    await requestClose()
    await waitForCondition(() => !!dialog()?.querySelector('[role="alert"]'), 'failure not said')
    expect(confirmButton()?.disabled).toBe(true)
    expect(rig.close).not.toHaveBeenCalled()
  })
  it('a session list read before whose read again fails stays shown, is said, and confirm stays off (❌ closes the old list)', async () => {
    rig.home = { kind: 'computer', hostKind: 'desktop', thisDevice: true, deviceId: 'this', label: null, online: true, known: true }
    rig.sessionsList.mockResolvedValueOnce({ sessions: [session('s-gugu', { agent: { userId: GUGU } }), session('s-child', { spawnedByConversationId: 's-gugu' })] })
      .mockRejectedValue(new Error('host gone'))
    await renderWithAppProviders(harness, createNode(AssistantCloseHost), { contacts: {} })
    await requestClose()
    await waitForCondition(() => shownSessions().includes('s-child'), 'started sessions not shown')
    expect(confirmButton()?.disabled).toBe(false)
    const { queryClient } = await import('../../../../apps/desktop/src/lib/replica')
    await act(async () => { await queryClient.refetchQueries({ type: 'active' }).catch(() => undefined) })
    await waitForCondition(() => !!dialog()?.querySelector('[role="alert"]'), 'refresh failure not said')
    expect(shownSessions()).toContain('s-child')
    expect(confirmButton()?.disabled).toBe(true)
  })
})
