// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { UnfinishedAgentCreateSweeper } from '../../../apps/desktop/src/components/UnfinishedAgentCreateSweeper'
import { readUnfinishedAgentCreates } from '../../../apps/desktop/src/lib/unfinishedAgentCreateBridge'
import { publishSelfIdentity } from '../../../apps/desktop/src/lib/selfIdentityBridge'
import { unfinishedAgentCreateRows } from '../../../apps/desktop/src/lib/unfinishedAgentCreateRows'
import { followRendererSession } from '../../../apps/desktop/src/lib/replica'

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const state = vi.hoisted(() => ({
  owner: 'owner',
  t: (key: string) => key,
  toast: vi.fn(), refresh: vi.fn(async () => undefined),
  sweep: vi.fn(async () => []),
  resume: vi.fn(async () => ({ kind: 'pending', stages: [] })),
  remove: vi.fn(async () => ({ kind: 'pending', stages: [] })),
}))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: state.t, i18n: { language: 'zh-CN' } }) }))
vi.mock('../../../apps/desktop/src/store/auth', () => ({ useAuth: () => ({ user: { id: state.owner } }) }))
vi.mock('../../../apps/desktop/src/store/chatContext', () => ({ useChatStore: () => ({ refreshChats: state.refresh }) }))
vi.mock('../../../apps/desktop/src/components/toastContext', () => ({ useToast: () => ({ toast: state.toast }) }))
vi.mock('../../../apps/desktop/src/lib/log', () => ({ rendererLogger: () => ({ error: vi.fn() }) }))
vi.mock('../../../apps/desktop/src/lib/userFacingError', () => ({ messageForUser: String }))
vi.mock('../../../apps/desktop/src/lib/agentProvision', () => ({ defaultResumeStore: { list: (owner: string) => [{ operationId: `op-${owner}`, blueprint: { kind: 'single', members: [{ display_name: owner }] } }] } }))
vi.mock('../../../apps/desktop/src/lib/unfinishedSingleAgentSweep', () => ({
  sweepUnfinishedSingleAgents: state.sweep,
  continueUnfinishedSingleAgent: state.resume,
  deleteUnfinishedSingleAgent: state.remove,
}))
let root: Root
let container: HTMLDivElement
async function show(owner = 'owner') {
  state.owner = owner
  followRendererSession('SIGNED_IN', owner)
  publishSelfIdentity({ userId: owner, displayName: null, guguNumber: null })
  if (!root) { container = document.createElement('div'); document.body.append(container); root = createRoot(container) }
  await act(async () => root.render(<UnfinishedAgentCreateSweeper />))
}
afterEach(async () => {
  if (root) await act(async () => root.unmount())
  root = undefined as unknown as Root
  container?.remove()
  publishSelfIdentity(null)
  followRendererSession('SIGNED_OUT', null)
  vi.clearAllMocks()
})
describe('shell recovery host', () => {
  it('publishes rows while the startup read is pending without starting an action', async () => {
    state.sweep.mockImplementationOnce(() => new Promise<never[]>(() => {}))
    await show()
    expect(readUnfinishedAgentCreates()).toMatchObject({ ownerUserId: 'owner', busy: false })
    expect(unfinishedAgentCreateRows.peek()).toMatchObject({ state: 'value', value: [{ operationId: 'op-owner' }] })
    expect(state.resume).not.toHaveBeenCalled()
    expect(state.remove).not.toHaveBeenCalled()
  })
  it('a double click starts only one explicit continuation', async () => {
    await show()
    const view = readUnfinishedAgentCreates()!
    await act(async () => { view.run('op-owner', 'continue'); view.run('op-owner', 'continue') })
    expect(state.resume).toHaveBeenCalledExactlyOnceWith('owner', 'op-owner')
    expect(state.remove).not.toHaveBeenCalled()
  })
  it('an old account callback cannot act after switching accounts', async () => {
    await show()
    const old = readUnfinishedAgentCreates()!
    await show('another')
    old.run('op-owner', 'delete')
    expect(state.remove).not.toHaveBeenCalled()
    expect(readUnfinishedAgentCreates()?.ownerUserId).toBe('another')
  })
  it('signing back into the same account does not revive the previous interaction', async () => {
    await show()
    const old = readUnfinishedAgentCreates()!
    await show('another')
    await show('owner')
    old.run('op-owner', 'delete')
    expect(state.remove).not.toHaveBeenCalled()
  })
})
