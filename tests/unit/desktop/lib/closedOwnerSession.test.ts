// @vitest-environment jsdom
import type { Session, User } from '@supabase/supabase-js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionCoordinator, type SessionCoordinatorDeps } from '../../../../apps/desktop/src/lib/sessionCoordinator'

const stops: (() => void)[] = []
afterEach(() => { for (const stop of stops.splice(0)) stop() })
function session(id = 'user-a'): Session {
  return { access_token: `access-${id}`, refresh_token: `refresh-${id}`, token_type: 'bearer', expires_in: 3600,
    user: { id, aud: 'authenticated', role: 'authenticated', email: `${id}@example.test`,
      user_metadata: { nickname: `Session ${id}` }, app_metadata: {}, created_at: '2026-01-01T00:00:00.000Z' } } as Session
}
function harness(overrides: Partial<SessionCoordinatorDeps> = {}) {
  const deps: SessionCoordinatorDeps = {
    getSession: vi.fn(() => new Promise<{ data: { session: Session | null }; error: unknown }>(() => {})),
    getUser: vi.fn(async (accessToken?: string) => ({ data: { user: session(accessToken?.replace(/^access-/, '') || 'user-a').user }, error: null })),
    refreshSession: vi.fn(async () => ({ data: { session: session() }, error: null })),
    restoreSession: vi.fn(async ({ access_token }) => ({ data: { session: session(access_token.replace(/^access-/, '')) }, error: null })),
    onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })),
    signOut: vi.fn(async () => ({ error: null })),
    hydrateUser: vi.fn(async (user: User) => ({ id: user.id, email: `${user.id}@example.test`, nickname: 'Canonical owner', bio: null })),
    publishSession: vi.fn(), writeMirror: vi.fn(async () => {}), clearMirror: vi.fn(async () => {}),
    loadPersistedSession: async () => {}, getPersistedSessionState: vi.fn(() => ({ bootCandidate: null, warning: null })),
    commitPersistedSession: vi.fn(async () => {}), clearPersistedSession: vi.fn(async () => {}),
    subscribeAppForeground: vi.fn(() => vi.fn()), ...overrides,
  }
  const coordinator = new SessionCoordinator(deps)
  return { deps, coordinator, login: (value: Session) => coordinator.acceptInteractiveSession(coordinator.beginInteractiveLogin(), value) }
}

describe('trusted closure finalization preserves the active owner', () => {
  it('finalizes the closed owner locally without another live-auth logout or mirror clear', async () => {
    const h = harness(); stops.push(h.coordinator.start()); await h.login(session())
    vi.mocked(h.deps.clearMirror).mockClear(); vi.mocked(h.deps.clearPersistedSession).mockClear()
    await h.coordinator.finalizeClosedOwner('user-a')
    expect(h.coordinator.getSnapshot()).toMatchObject({ status: 'anonymous', session: null })
    expect(h.deps.clearPersistedSession).toHaveBeenCalledWith(session(), expect.any(AbortSignal))
    expect(h.deps.signOut).not.toHaveBeenCalled(); expect(h.deps.clearMirror).not.toHaveBeenCalled()
    expect(h.deps.publishSession).toHaveBeenLastCalledWith('ACCOUNT_CLOSED', null)
  })
  it('refuses A closure finalization while B is current', async () => {
    const h = harness(); stops.push(h.coordinator.start()); await h.login(session('user-b'))
    await expect(h.coordinator.finalizeClosedOwner('user-a')).rejects.toMatchObject({ code: 'wrong_local_owner' })
    expect(h.coordinator.getSnapshot().session?.user.id).toBe('user-b')
    expect(h.deps.clearPersistedSession).not.toHaveBeenCalled(); expect(h.deps.signOut).not.toHaveBeenCalled()
  })
  it('a B login during A local cleanup is preserved and cannot be published as signed out', async () => {
    let finishClearing!: () => void
    const clearing = { promise: new Promise<void>(resolve => { finishClearing = resolve }), resolve: () => finishClearing() }
    const h = harness({ clearPersistedSession: vi.fn(() => clearing.promise) }); stops.push(h.coordinator.start()); await h.login(session())
    const closing = h.coordinator.finalizeClosedOwner('user-a')
    await vi.waitFor(() => expect(h.deps.clearPersistedSession).toHaveBeenCalledOnce())
    await h.login(session('user-b')); clearing.resolve()
    await expect(closing).rejects.toMatchObject({ code: 'wrong_local_owner' })
    expect(h.coordinator.getSnapshot().session?.user.id).toBe('user-b')
    expect(h.deps.publishSession).not.toHaveBeenCalledWith('ACCOUNT_CLOSED', null)
  })
})
