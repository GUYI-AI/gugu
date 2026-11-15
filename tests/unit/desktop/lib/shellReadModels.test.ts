// @vitest-environment jsdom
import { notifyManager } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Read model PR 3, shell domain: reads that used to swallow a failure into a value now fail loud, the frozen legacy-DM
 * archive is read once and never refreshed, and the SSH machine registry is read once (the replica) for routing too.
 */
const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  scope: vi.fn(),
  messages: vi.fn(),
  policy: vi.fn(),
}))

vi.mock('../../../../apps/desktop/src/components/legacy-dm-history/data', () => ({
  readLegacyDmList: mocks.list,
  readSessionLegacyScope: mocks.scope,
  readLegacyDmMessages: mocks.messages,
  hasLegacyDmHistory: vi.fn(),
}))
vi.mock('../../../../apps/desktop/src/lib/supabase', () => ({
  dataClient: { schema: () => ({ from: () => ({ select: () => ({ single: () => mocks.policy() }) }) }) },
}))

beforeEach(() => {
  notifyManager.setScheduler((callback) => { callback() })
  localStorage.clear()
  vi.resetModules()
  for (const mock of Object.values(mocks)) mock.mockReset()
})

async function signedIn() {
  const replica = await import('../../../../apps/desktop/src/lib/replica')
  replica.followRendererSession('SIGNED_IN', 'owner-1')
  return replica
}

describe('legacy DM archive', () => {
  it('reads the archive once: no refresh source, and appended pages stay', async () => {
    await signedIn()
    const { legacyDmList } = await import('../../../../apps/desktop/src/components/legacy-dm-history/legacyDmReplicas')
    mocks.list.mockResolvedValue({ rows: [{ id: 'a', publicId: 1, name: 'A', updatedAt: '2026-01-01T00:00:00Z', agent: null }], after: 'a' })
    await legacyDmList.fetch(null, '')
    legacyDmList.at(null, '').set((current) => current && { ...current, rows: [...current.rows, { id: 'b', publicId: 2, name: 'B', updatedAt: '2026-01-02T00:00:00Z', agent: null }], after: null })
    // Another open, a prefetch and the window coming back: none reads the frozen archive again.
    await legacyDmList.fetch(null, '')
    await legacyDmList.prefetch(null, '')
    window.dispatchEvent(new Event('focus'))
    await Promise.resolve()
    expect(mocks.list).toHaveBeenCalledTimes(1)
    expect(legacyDmList.peek(null, '')).toMatchObject({ state: 'value', value: { rows: [{ id: 'a' }, { id: 'b' }], after: null } })
  })

  it('a session with no verifiable identity has no history: a value, not unknown', async () => {
    await signedIn()
    const { legacyDmList } = await import('../../../../apps/desktop/src/components/legacy-dm-history/legacyDmReplicas')
    mocks.scope.mockResolvedValue(null)
    await expect(legacyDmList.fetch('session-1', '')).resolves.toEqual({ scope: null, rows: [], after: null })
    expect(mocks.list).not.toHaveBeenCalled()
  })
})

describe('reads that fail loud', () => {
  it('runtime capability policy: a failed read is an error (❌ 0, which hid the badge)', async () => {
    await signedIn()
    const { runtimeCapabilityPolicy } = await import('../../../../apps/desktop/src/lib/runtimeCapabilityPolicy')
    mocks.policy.mockResolvedValue({ data: null, error: { message: 'denied' } })
    await runtimeCapabilityPolicy.prefetch()
    expect(runtimeCapabilityPolicy.peek()).toMatchObject({ state: 'error' })
    mocks.policy.mockResolvedValue({ data: { min_critical_capability: 7 }, error: null })
    await expect(runtimeCapabilityPolicy.fetch()).resolves.toBe(7)
  })

  it('Google sign-in settings: a failed answer rejects (❌ a false "not enabled")', async () => {
    const { readGoogleProviderEnabled } = await import('../../../../apps/desktop/src/lib/authProviderSettings')
    const failing = vi.fn(async () => new Response('', { status: 503 })) as unknown as typeof fetch
    await expect(readGoogleProviderEnabled('https://example.test', 'anon', failing)).rejects.toThrow('503')
    const enabled = vi.fn(async () => new Response(JSON.stringify({ external: { google: true } }), { status: 200 })) as unknown as typeof fetch
    await expect(readGoogleProviderEnabled('https://example.test', 'anon', enabled)).resolves.toBe(true)
  })
})

describe('SSH machine registry', () => {
  it('routing reads the one replica: not known until read, then its machines', async () => {
    const invoke = vi.fn(async (channel: string) => channel === 'server-ssh-machines:describe' ? [{ deviceId: 'ssh-1', display: 'me@box' }] : undefined)
    vi.stubGlobal('electronAPI', { invoke, eventOn: () => () => undefined })
    Object.assign(window, { electronAPI: { invoke, eventOn: () => () => undefined } })
    await signedIn()
    const channel = await import('../../../../apps/desktop/src/lib/sshLinkChannel')
    expect(channel.isSshMachine('ssh-1')).toBe(false)
    await channel.sshMachinesReady()
    expect(channel.isSshMachine('ssh-1')).toBe(true)
    // One read serves the next callers (pushed: main says when it changes).
    await channel.sshMachinesReady()
    expect(invoke.mock.calls.filter(([name]) => name === 'server-ssh-machines:describe')).toHaveLength(1)
    expect(invoke.mock.calls.some(([name]) => name === 'server-ssh-machines:list')).toBe(false)
    delete (window as { electronAPI?: unknown }).electronAPI
    vi.unstubAllGlobals()
  })
})
