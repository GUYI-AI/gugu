// @vitest-environment jsdom
import type { Session, User } from '@supabase/supabase-js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionCoordinator, type SessionCoordinatorDeps } from '../../../../apps/desktop/src/lib/sessionCoordinator'

const stops: (() => void)[] = []
afterEach(() => { for (const stop of stops.splice(0)) stop() })
function session(id = 'user-a'): Session {
  return { access_token: `access-${id}`, refresh_token: `refresh-${id}`, token_type: 'bearer', expires_in: 3600,
    user: { id, aud: 'authenticated', role: 'authenticated', email: `${id}@example.test`,
      user_metadata: {}, app_metadata: {}, created_at: '2026-01-01T00:00:00.000Z' } } as Session
}
function harness(overrides: Partial<SessionCoordinatorDeps> = {}) {
  const deps: SessionCoordinatorDeps = {
    getSession: vi.fn(async () => ({ data: { session: null }, error: null })),
    getUser: vi.fn(async (accessToken?: string) => ({ data: { user: session(accessToken?.replace(/^access-/, '') || 'user-a').user }, error: null })),
    refreshSession: vi.fn(async () => ({ data: { session: session() }, error: null })),
    restoreSession: vi.fn(async ({ access_token }) => ({ data: { session: session(access_token.replace(/^access-/, '')) }, error: null })),
    onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })),
    signOut: vi.fn(async () => ({ error: null })),
    hydrateUser: vi.fn(async (user: User) => ({ id: user.id, email: `${user.id}@example.test`, nickname: 'Owner', bio: null })),
    publishSession: vi.fn(), writeMirror: vi.fn(async () => {}), clearMirror: vi.fn(async () => {}),
    loadPersistedSession: async () => {}, getPersistedSessionState: vi.fn(() => ({ bootCandidate: null, warning: null })),
    commitPersistedSession: vi.fn(async () => {}), clearPersistedSession: vi.fn(async () => {}),
    subscribeAppForeground: vi.fn(() => vi.fn()), ...overrides,
  }
  const coordinator = new SessionCoordinator(deps)
  return { deps, coordinator, login: (value: Session) => coordinator.acceptInteractiveSession(coordinator.beginInteractiveLogin(), value) }
}

describe('gugu-dev#1616 a sign-in enters that account\'s own local data', () => {
  it('shows nothing of an account whose directories another process serves: the host relaunches into them', async () => {
    const enterAccount = vi.fn(async () => 'switching' as const)
    const h = harness({ enterAccount })
    stops.push(h.coordinator.start())
    await vi.waitFor(() => expect(h.coordinator.getSnapshot().status).toBe('anonymous'))
    await h.login(session('user-b'))
    expect(enterAccount).toHaveBeenCalledWith(session('user-b'))
    expect(h.coordinator.getSnapshot()).toMatchObject({ status: 'anonymous', session: null })
    expect(h.deps.commitPersistedSession).not.toHaveBeenCalled()
    expect(h.deps.publishSession).not.toHaveBeenCalledWith(expect.anything(), session('user-b'))
    expect(h.deps.writeMirror).not.toHaveBeenCalled()
  })

  it('signs in here when this process serves the account, and asks only when the shown account changes', async () => {
    const enterAccount = vi.fn(async () => 'here' as const)
    const h = harness({ enterAccount })
    stops.push(h.coordinator.start())
    await vi.waitFor(() => expect(h.coordinator.getSnapshot().status).toBe('anonymous'))
    await h.login(session('user-a'))
    expect(h.coordinator.getSnapshot().session?.user.id).toBe('user-a')
    await h.login(session('user-a'))
    expect(enterAccount).toHaveBeenCalledOnce()
  })

  it('fails the sign-in when the host cannot answer, instead of showing the account over another one\'s data', async () => {
    const h = harness({ enterAccount: vi.fn(async () => { throw new Error('Invalid account registry') }) })
    stops.push(h.coordinator.start())
    await vi.waitFor(() => expect(h.coordinator.getSnapshot().status).toBe('anonymous'))
    await expect(h.login(session('user-b'))).rejects.toThrow('Invalid account registry')
    expect(h.deps.commitPersistedSession).not.toHaveBeenCalled()
  })

  it('restores the session a switch handed over in the next account\'s first window', async () => {
    const takeAccountHandoff = vi.fn(async () => ({ access_token: 'access-user-b', refresh_token: 'refresh-user-b' }))
    const enterAccount = vi.fn(async () => 'here' as const)
    const h = harness({ takeAccountHandoff, enterAccount })
    stops.push(h.coordinator.start())
    await vi.waitFor(() => expect(h.coordinator.getSnapshot().session?.user.id).toBe('user-b'))
    expect(h.deps.restoreSession).toHaveBeenCalledWith({ access_token: 'access-user-b', refresh_token: 'refresh-user-b' })
    expect(h.deps.commitPersistedSession).toHaveBeenCalledWith(session('user-b'), expect.any(AbortSignal))
    expect(takeAccountHandoff).toHaveBeenCalledOnce()
  })

  it('takes no handoff over a session this profile already has', async () => {
    const takeAccountHandoff = vi.fn(async () => null)
    const h = harness({ takeAccountHandoff, getPersistedSessionState: vi.fn(() => ({ bootCandidate: session('user-a'), warning: null })),
      getSession: vi.fn(async () => ({ data: { session: session('user-a') }, error: null })) })
    stops.push(h.coordinator.start())
    await vi.waitFor(() => expect(h.coordinator.getSnapshot().session?.user.id).toBe('user-a'))
    expect(takeAccountHandoff).not.toHaveBeenCalled()
  })
})
