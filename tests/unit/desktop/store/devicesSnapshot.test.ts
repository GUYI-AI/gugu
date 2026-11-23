// @vitest-environment jsdom
import { notifyManager } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Device, DeviceSessionSummary } from '@gugu/core/shared/types/chat'
import type { DeviceProject } from '@gugu/core/shared/types/deviceProject'
import { DEVICE_SESSION_DIGEST_LIMIT } from '@gugu/core/cloud/deviceRuntime'

/**
 * The machine list across a restart (devicesModel's snapshot): a row as read carries its action list, session digest and
 * projects, ~15 KB for a Mac in use, so two machines outgrew the entry's limit and the first frame after a restart was
 * empty. The snapshot keeps each machine's card; the parts that grow with use read as "not read yet" until the next read.
 */
const reads = vi.hoisted(() => ({ rows: [] as Device[] }))
vi.mock('../../../../apps/desktop/src/store/devicesRead', () => ({ readDevices: async () => reads.rows }))

type Cache = typeof import('../../../../apps/desktop/src/store/devicesCache')
type Replica = typeof import('../../../../apps/desktop/src/lib/replica')

async function start(): Promise<{ cache: Cache; replica: Replica }> {
  // A new renderer process: module state gone, localStorage kept (what a restart keeps).
  vi.resetModules()
  const replica = await import('../../../../apps/desktop/src/lib/replica')
  const cache = await import('../../../../apps/desktop/src/store/devicesCache')
  return { cache, replica }
}

const ACCOUNT = 'eb12875b-0000-4000-8000-000000000001'
const at = '2026-11-22T20:00:00.000Z'

// Shapes as the list read gives them (a real desktop row measured 2.9 KB with 8 actions; a Mac registers dozens).
const action = (i: number) => ({
  name: `group${i % 12}.action${i}`, group: `group${i % 12}`, title: '看屏幕', risk: 'medium' as const, confirm: 'never' as const, available: false,
  unavailable_reason: 'not_granted' as const,
  unavailable_detail: 'On that computer, open 咕咕 → Settings → Devices → What this computer can do, and connect "屏幕 / Screen".',
})
const session = (i: number): DeviceSessionSummary => ({
  conversationId: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, projectId: `project-${i % 5}`, projectName: 'gugu',
  title: `Fix the machine list after a restart, part ${i}`, harness: 'claude', agentStatus: 'idle', status: null,
  lastInteractedAt: at, supported: true, isPinned: false, unseen: false, parentConversationId: null, agentUserId: null,
})
const project = (i: number): DeviceProject => ({
  localProjectId: `local-${i}`, name: `project ${i}`, rootPath: `/Users/someone/Code/project-${i}`, createdAt: at, chatId: null,
  folders: [{ workspaceId: `workspace-${i}`, kind: 'root', path: `/Users/someone/Code/project-${i}`, attachedAt: null }],
})
function mac(i: number): Device {
  return {
    device_id: `00000000-0000-4000-8000-0000000000${String(i).padStart(2, '0')}`, label: `Studio ${i}`, hostname: `studio-${i}.local`,
    platform: 'darwin', status: 'online', last_seen_at: at, created_at: at, is_online: i % 2 === 0, is_current_device: i === 0,
    machine_id: `machine-${i}`, tier: 'beta',
    capabilities: {
      terminals: ['tmux'], runtimes: ['claude', 'codex'], host_kind: 'desktop', os_name: 'macOS 26.1', arch: 'arm64', home_dir: '/Users/someone',
      app_version: '0.3.10', host_runtime_capability: 1,
      actions: { v: 1, timezone: 'Asia/Shanghai', actions: Array.from({ length: 60 }, (_, n) => action(n)) },
    },
    session_digest: Array.from({ length: DEVICE_SESSION_DIGEST_LIMIT }, (_, n) => session(n)),
    projects: Array.from({ length: 5 }, (_, n) => project(n)),
  }
}

beforeEach(() => {
  notifyManager.setScheduler((callback) => { callback() })
  localStorage.clear()
})
afterEach(() => { vi.restoreAllMocks() })

describe('devices across a restart', () => {
  it.each([2, 5])('%i machines in use: kept, and the first frame after a restart lists them', async (count) => {
    reads.rows = Array.from({ length: count }, (_, i) => mac(i))
    expect(JSON.stringify(reads.rows).length, 'the rows as read outgrow the limit on their own').toBeGreaterThan(8192)
    const refused = vi.spyOn(console, 'error')

    const first = await start()
    first.replica.followRendererSession('SIGNED_IN', ACCOUNT)
    await first.cache.devicesModel.prefetch()
    expect(first.cache.readCachedDevices()).toHaveLength(count)
    expect(refused.mock.calls.flat().join(' ')).not.toContain('not kept across restarts')

    // Restart: what the first frame has before any read.
    const next = await start()
    const reading = next.cache.devicesModel.peek()
    expect(reading).toMatchObject({ state: 'value', stale: true })
    const rows = next.cache.readCachedDevices()
    expect(rows.map((row) => [row.device_id, row.label, row.is_online, row.capabilities.app_version]))
      .toEqual(reads.rows.map((row) => [row.device_id, row.label, row.is_online, row.capabilities.app_version]))
    // The parts that grow with use are not read yet (❌ an empty list standing in for one).
    for (const row of rows) {
      expect(row.session_digest).toBeUndefined()
      expect(row.projects).toBeUndefined()
      expect(row.capabilities.actions).toBeUndefined()
    }
  })

  it('a card is the row without its action list, session digest and projects', async () => {
    const { cache } = await start()
    const row = { ...mac(1), projects_error: 'offline' }
    const card = cache.deviceCard(row)
    const { session_digest: _d, projects: _p, projects_error: _e, capabilities: { actions: _a, ...capabilities }, ...rest } = row
    expect(card).toEqual({ ...rest, capabilities })
    expect(JSON.stringify(card).length).toBeLessThan(700)
  })
})
