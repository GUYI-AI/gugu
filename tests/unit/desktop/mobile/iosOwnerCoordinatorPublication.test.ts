// @vitest-environment jsdom
import type { Session } from '@supabase/supabase-js'
import { afterEach, expect, it, vi } from 'vitest'
import { SessionCoordinator, type SessionCoordinatorDeps } from '../../../../apps/desktop/src/lib/sessionCoordinator'
import { IOSOwnerPublication } from '../../../../apps/desktop/src/mobile/ios-runtime/iosOwnerPublication'
import type { IOSOwnerClient } from '../../../../apps/desktop/src/mobile/ios-runtime/iosOwnerClient'

const ownerId = '10000000-0000-0000-0000-000000000001', installationId = '30000000-0000-0000-0000-000000000003'
const binding = { ownerId, installationId, deviceId: `phone-${installationId}-${ownerId}` }
const session = (token: string): Session => ({ user: { id: ownerId }, access_token: `synthetic-access-${token}`,
  refresh_token: `synthetic-refresh-${token}`, expires_at: Date.now() / 1_000 + 3_600 } as Session)
function gate() { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes }); return { promise, resolve } }
const flush = async () => { for (let i = 0; i < 40; ++i) await Promise.resolve() }
afterEach(() => vi.useRealTimers())

it('subscribes to the real coordinator commit/publication barrier while the coordinator alone owns refresh', async () => {
  vi.useFakeTimers(); vi.setSystemTime(1_800_000_000_000)
  const initialCommit = gate(), rotatedCommit = gate(), events: string[] = []
  const deps: SessionCoordinatorDeps = {
    getSession: vi.fn(async () => ({ data: { session: session('initial') }, error: null })),
    getUser: vi.fn(async () => ({ data: { user: session('initial').user }, error: null })),
    refreshSession: vi.fn(async () => { events.push('coordinator-refresh'); return { data: { session: session('rotated') }, error: null } }),
    restoreSession: vi.fn(async () => ({ data: { session: null }, error: null })),
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
    signOut: vi.fn(async () => ({ error: null })),
    hydrateUser: async user => ({ id: user.id, email: '', nickname: 'Owner' }),
    publishSession: () => {}, writeMirror: async () => {}, clearMirror: async () => {},
    getPersistedSessionState: () => ({ bootCandidate: null, warning: null }),
    loadPersistedSession: async () => {},
    commitPersistedSession: async value => {
      const rotated = value.access_token.endsWith('rotated')
      events.push(rotated ? 'rotated-commit-begin' : 'initial-commit-begin')
      await (rotated ? rotatedCommit : initialCommit).promise
      events.push(rotated ? 'rotated-commit-end' : 'initial-commit-end')
    },
    clearPersistedSession: async () => {}, subscribeAppForeground: () => () => {},
  }
  const coordinator = new SessionCoordinator(deps)
  const client: IOSOwnerClient = { available: () => true,
    publish: vi.fn(async input => { events.push(input.accessToken.endsWith('rotated') ? 'native-rotated' : 'native-initial'); return binding }),
    getBinding: vi.fn(async () => binding), retire: vi.fn(async () => {}) }
  const publication = new IOSOwnerPublication(coordinator, client, () => () => {})
  publication.start()
  const stopCoordinator = coordinator.start()
  try {
    await flush()
    expect(events).toEqual(['initial-commit-begin'])
    expect(client.publish).not.toHaveBeenCalled()
    initialCommit.resolve(); await flush()
    expect(publication.getSnapshot()).toMatchObject({ status: 'ready', binding })
    expect(client.publish).toHaveBeenCalledExactlyOnceWith({ ownerId, accessToken: 'synthetic-access-initial' })
    const refreshing = coordinator.refresh(); await flush()
    expect(events).toContain('rotated-commit-begin')
    const waitingOnHandoff = publication.refresh(); await flush()
    expect(publication.getSnapshot()).toMatchObject({ status: 'publishing', binding: null })
    expect(client.publish).toHaveBeenCalledOnce()
    rotatedCommit.resolve(); await refreshing; await waitingOnHandoff; await flush()
    expect(client.publish).toHaveBeenCalledTimes(2)
    expect(vi.mocked(client.publish).mock.calls[1]).toEqual([{ ownerId, accessToken: 'synthetic-access-rotated' }])
    expect(events.indexOf('rotated-commit-end')).toBeLessThan(events.indexOf('native-rotated'))
    expect(deps.refreshSession).toHaveBeenCalledOnce()
    expect(deps.restoreSession).not.toHaveBeenCalled(); expect(deps.signOut).not.toHaveBeenCalled()
    await publication.stop()
    expect(coordinator.getSnapshot().status).toBe('authenticated')
    expect(client.retire).toHaveBeenCalledExactlyOnceWith(ownerId)
  } finally { initialCommit.resolve(); rotatedCommit.resolve(); await publication.stop(); stopCoordinator() }
})
