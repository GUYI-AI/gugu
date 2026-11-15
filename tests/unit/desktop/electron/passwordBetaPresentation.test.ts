import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ row: { id: 'session', archivedAt: null as number | null, runtime: 'acp' },
  bound: { ownerUserId: 'owner', agentUserId: 'agent', name: '登录助理' } as { ownerUserId: string; agentUserId: string; name: string } | undefined,
  title: '网站登录' as string | undefined }))
vi.mock('@main/db/client', () => ({ db: { select: () => ({ from: () => ({ where: () => ({ get: () => state.row }) }) }) } }))
vi.mock('@main/db/schema', () => ({ sessions: { id: 'id' } }))
vi.mock('drizzle-orm', () => ({ eq: () => true }))
vi.mock('../../../../apps/desktop/electron/session/main/core/sessions/task-name', () => ({
  boundTaskName: () => state.bound, knownTaskName: () => state.title,
}))
import { passwordRequestPresentation } from '../../../../apps/desktop/electron/session/main/core/sessions/password-beta-presentation'

describe('password request names from native session records', () => {
  beforeEach(() => { state.bound = { ownerUserId: 'owner', agentUserId: 'agent', name: '登录助理' }; state.title = '网站登录'; state.row.archivedAt = null; state.row.runtime = 'acp' })
  it('uses roster and session names without returning identity IDs', () => {
    expect(passwordRequestPresentation('owner', 'agent', 'session')).toEqual({ agentName: '登录助理', sessionTitle: '网站登录' })
  })
  it('uses readable labels when names are missing or UUID-shaped', () => {
    state.bound = undefined; state.title = undefined
    expect(passwordRequestPresentation('owner', 'agent', 'session')).toEqual({ agentName: '此 Agent', sessionTitle: '当前会话' })
    state.bound = { ownerUserId: 'owner', agentUserId: 'agent', name: '11111111-1111-4111-8111-111111111111' }; state.title = 'session:11111111-1111-4111-8111-111111111111'
    expect(passwordRequestPresentation('owner', 'agent', 'session')).toEqual({ agentName: '此 Agent', sessionTitle: '当前会话' })
  })
  it.each(['owner', 'agent'])('refuses a %s binding mismatch instead of borrowing another identity name', field => {
    expect(() => passwordRequestPresentation(field === 'owner' ? 'foreign' : 'owner', field === 'agent' ? 'foreign' : 'agent', 'session')).toThrow('password_presentation_unavailable')
  })
  it.each(['archived', 'pty'])('refuses a %s session', stateName => {
    if (stateName === 'archived') state.row.archivedAt = 1; else state.row.runtime = 'pty'
    expect(() => passwordRequestPresentation('owner', 'agent', 'session')).toThrow('password_presentation_unavailable')
  })
})
