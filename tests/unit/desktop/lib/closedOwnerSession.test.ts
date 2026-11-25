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
  it('leaves encrypted-storage failure unresolved without refreshing, publishing or signing out', async () => {
    const error = Object.assign(new Error('safe storage failure'), { code: 'auth_storage_recovery_required' })
    const h = harness({ loadPersistedSession: vi.fn(async () => { throw error }) })
    stops.push(h.coordinator.start())
    await vi.waitFor(() => expect(h.coordinator.getSnapshot()).toMatchObject({ status: 'degraded', error }))
    expect(h.deps.getSession).not.toHaveBeenCalled()
    expect(h.deps.refreshSession).not.toHaveBeenCalled()
    expect(h.deps.signOut).not.toHaveBeenCalled()
    expect(h.deps.clearPersistedSession).not.toHaveBeenCalled()
    expect(h.deps.publishSession).not.toHaveBeenCalled()
  })

  it('retries temporary storage reads once then waits for an explicit retry without auth effects', async () => {
    const error = Object.assign(new Error('safe temporary failure'), { code: 'auth_storage_unavailable' })
    const read = vi.fn(async () => { throw error })
    const h = harness({ loadPersistedSession: read }); stops.push(h.coordinator.start())
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2))
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(read).toHaveBeenCalledTimes(2); expect(h.deps.getSession).not.toHaveBeenCalled()
    await h.coordinator.retryAuthStorage(); expect(read).toHaveBeenCalledTimes(4)
    expect(h.deps.signOut).not.toHaveBeenCalled(); expect(h.deps.clearPersistedSession).not.toHaveBeenCalled()
  })
  it('one temporary read failure recovers without clearing storage or signing out', async () => {
    const error = Object.assign(new Error('temporary'), { code: 'auth_storage_unavailable' })
    const read = vi.fn(async () => {}).mockRejectedValueOnce(error)
    const h = harness({ loadPersistedSession: read }); stops.push(h.coordinator.start())
    await vi.waitFor(() => expect(h.deps.getSession).toHaveBeenCalledOnce())
    expect(read).toHaveBeenCalledTimes(2)
    expect(h.deps.signOut).not.toHaveBeenCalled(); expect(h.deps.clearPersistedSession).not.toHaveBeenCalled()
  })
  it('a newer login cannot be published anonymous by an old reset completion', async () => {
    const error = Object.assign(new Error('unreadable'), { code: 'auth_storage_recovery_required' })
    let finish!: () => void
    const resetting = new Promise<void>(resolve => { finish = resolve })
    const reset = vi.fn(() => resetting)
    const h = harness({ loadPersistedSession: async () => { throw error }, resetUnreadableStorage: reset })
    stops.push(h.coordinator.start()); await vi.waitFor(() => expect(h.coordinator.getSnapshot().error).toBe(error))
    const attempt = h.coordinator.resetUnreadableAuthStorage('revision')
    const rejected = expect(attempt).rejects.toMatchObject({ code: 'auth_storage_unavailable' })
    await vi.waitFor(() => expect(reset).toHaveBeenCalledOnce()); await h.login(session('user-b')); finish()
    await rejected
    expect(h.coordinator.getSnapshot().session?.user.id).toBe('user-b')
    expect(h.deps.publishSession).not.toHaveBeenCalledWith('AUTH_STORAGE_RESET', null)
  })
  it('explicit unreadable recovery publishes anonymous only after native reset and never signs out', async () => {
    const error = Object.assign(new Error('safe unreadable failure'), { code: 'auth_storage_recovery_required' })
    const reset = vi.fn(async () => {})
    const h = harness({ loadPersistedSession: async () => { throw error }, resetUnreadableStorage: reset })
    stops.push(h.coordinator.start())
    await vi.waitFor(() => expect(h.coordinator.getSnapshot().error).toBe(error))
    await h.coordinator.resetUnreadableAuthStorage('revision')
    expect(reset).toHaveBeenCalledWith('revision', expect.any(AbortSignal))
    expect(h.coordinator.getSnapshot().status).toBe('anonymous')
    expect(h.deps.publishSession).toHaveBeenLastCalledWith('AUTH_STORAGE_RESET', null)
    expect(h.deps.signOut).not.toHaveBeenCalled(); expect(h.deps.clearPersistedSession).not.toHaveBeenCalled()
  })
  it('native closure refusal preserves the unresolved session and performs no sign-out', async () => {
    const error = Object.assign(new Error('safe unreadable failure'), { code: 'auth_storage_recovery_required' })
    const denied = Object.assign(new Error('retained custody'), { code: 'auth_storage_closure_pending' })
    const h = harness({ loadPersistedSession: async () => { throw error }, resetUnreadableStorage: async () => { throw denied } })
    stops.push(h.coordinator.start()); await vi.waitFor(() => expect(h.coordinator.getSnapshot().error).toBe(error))
    await expect(h.coordinator.resetUnreadableAuthStorage('revision')).rejects.toBe(denied)
    expect(h.coordinator.getSnapshot()).toMatchObject({ status: 'degraded', error })
    expect(h.deps.publishSession).not.toHaveBeenCalled(); expect(h.deps.signOut).not.toHaveBeenCalled()
  })

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
