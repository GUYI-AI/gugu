// @vitest-environment jsdom
import { notifyManager } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Device } from '@gugu/core/shared/types/chat'
import { deviceSessionsOf } from '../../../../apps/desktop/src/session/shared/remote-sessions/session-directory'

/**
 * The devices replica is the phone's first page after a cold start: it must be kept across restarts for a real account.
 * A row's session digest (≤ 50 summaries, ~28 K for one active computer) made the whole entry larger than its limit, so
 * every write was refused and every start began unknown. The digest is not carried; a row without it reads as "not
 * known yet", ❌ as no sessions.
 */
const digest = Array.from({ length: 40 }, (_, n) => ({
  conversationId: `conv-${n}`, title: `A long enough task title number ${n} with some words`, harness: 'claude', status: 'idle',
  projectId: `proj-${n % 5}`, projectName: `project ${n % 5}`, updatedAt: '2026-11-15T10:00:00.000Z', model: 'claude-opus',
}))
const row = (id: string): Device => ({
  device_id: id, label: `Computer ${id}`, hostname: `${id}.local`, platform: 'darwin', status: 'online', is_online: false,
  last_seen_at: '2026-11-15T10:00:00.000Z', created_at: '2026-11-01T10:00:00.000Z', machine_id: `m-${id}`, tier: 'desktop',
  capabilities: { host_kind: 'desktop' }, session_digest: digest,
} as unknown as Device)

beforeEach(() => {
  notifyManager.setScheduler((callback) => { callback() })
  localStorage.clear()
  vi.resetModules()
})

describe('devices kept across restarts', () => {
  it('an active account\'s machines are kept, without the digest, and restored on the next start', async () => {
    let rm = await import('../../../../apps/desktop/src/lib/replica')
    rm.followRendererSession('SIGNED_IN', 'alice')
    let cache = await import('../../../../apps/desktop/src/store/devicesCache')
    cache.devicesModel.set([], [row('a'), row('b')])
    vi.resetModules()
    rm = await import('../../../../apps/desktop/src/lib/replica')
    cache = await import('../../../../apps/desktop/src/store/devicesCache')
    const restored = cache.devicesModel.peek()
    expect(restored.state).toBe('value')
    const rows = restored.state === 'value' ? restored.value : []
    expect(rows.map((device) => [device.device_id, device.session_digest])).toEqual([['a', undefined], ['b', undefined]])
  })

  it('a restored row (no digest) lists its sessions as still loading, ❌ as none', () => {
    const { session_digest: _digest, ...restored } = row('a')
    expect(deviceSessionsOf(restored as Device, {})).toMatchObject({ sessions: [], loading: true })
    expect(deviceSessionsOf(row('a'), {})).toMatchObject({ loading: false })
  })
})
