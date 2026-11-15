import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SettingsTableClient } from '@gugu/core/cloud/userSettings'
import { updateUserSettingsConfig } from '@gugu/core/cloud/userSettings'
import { rememberAgentCreateDevice, rememberAgentCreateProject } from '@gugu/core/cloud/agentCreateDefaults'
import { versionedSettingsClient } from '../../../support/versionedSettingsTestDouble'

const io = vi.hoisted(() => ({ rows: new Map<string, Record<string, unknown>>(), failWrite: false, readWait: null as Promise<void> | null, reads: 0, conflicts: 0 }))
vi.mock('@/lib/supabase', async () => {
  const { versionedSettingsClient } = await import('../../../support/versionedSettingsTestDouble')
  return { identityDb: versionedSettingsClient(io), chatDb: {} }
})
vi.mock('@/lib/identityReadAdapter', () => ({ readOwnOnboardedAt: vi.fn() }))

const firstRun = await import('@/lib/firstRun')
const hints = await import('@/lib/firstRunHints')
const files = await import('@/lib/fileStorage')
const tour = await import('@/lib/productTour')
const sample = await import('@/lib/sampleProject')
const client = versionedSettingsClient(io)
const config = () => io.rows.get('u/user')?.config as Record<string, unknown>

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

type Writer = { name: string; key: string; write: (client: SettingsTableClient) => Promise<unknown>; expected: unknown }
const writers: Writer[] = [
  { name: 'agent device', key: 'agent_create', write: (db) => rememberAgentCreateDevice(db, 'u', 'device'), expected: { device_id: 'device' } },
  { name: 'agent project', key: 'agent_create', write: (db) => rememberAgentCreateProject(db, 'u', 'device', 'project', 'chat'), expected: { project_by_device: { device: 'project' }, project_by_chat: { chat: { device_id: 'device', project_id: 'project' } } } },
  { name: 'occupation', key: 'profile', write: () => firstRun.writeOccupation('u', { key: 'research' }), expected: { occupation: 'research' } },
  { name: 'harness', key: 'firstRunHarness', write: () => firstRun.writeFirstRunHarness('u', ['codex']), expected: ['codex'] },
  { name: 'terminal seen', key: 'firstRunTerminal', write: () => firstRun.writeFirstRunTerminalSeen('u'), expected: true },
  { name: 'hint enrollment', key: 'firstRunHints', write: () => hints.startFirstRunHints('u'), expected: { version: 1, dismissed: [] } },
  { name: 'hint dismissal', key: 'firstRunHints', write: () => hints.dismissFirstRunHints('u', ['assistant']), expected: { version: 1, dismissed: ['assistant'] } },
  { name: 'file storage', key: 'file_storage', write: () => files.writeFileStorage('u', { retention: '1d' }), expected: { retention: '1d' } },
  { name: 'tour progress', key: 'productTour', write: () => tour.saveProductTourState('u', { step: 'tasks', status: 'active' }), expected: { version: 2, step: 'tasks', status: 'active' } },
]

function expectSaved(writer: Writer) {
  if (writer.expected !== null && typeof writer.expected === 'object') expect(config()[writer.key]).toMatchObject(writer.expected)
  else expect(config()[writer.key]).toBe(writer.expected)
}

beforeEach(() => { io.rows.clear(); io.failWrite = false; io.readWait = null; io.reads = 0; io.conflicts = 0 })

describe('real account preference writers preserve a confirmed sample dismissal', () => {
  it.each(writers)('$name reapplies its edit after a stale read instead of restoring the removed sample', async (writer) => {
    io.rows.set('u/user', { user_id: 'u', scope: 'user', updated_at: '2026-10-29T00:00:00.000Z', config: {
      sampleProject: { version: 1, dismissed: false }, unrelated: 'old',
      ...(writer.name === 'hint dismissal' ? { firstRunHints: { version: 1, dismissed: [] } } : {}),
    } })
    const wait = deferred()
    io.readWait = wait.promise
    const late = writer.write(client)
    expect(io.reads).toBe(1)
    await sample.dismissSampleProject('u')
    await updateUserSettingsConfig(client, 'u', 'user', (value) => ({ ...value, unrelated: 'new', futurePreference: { keep: true } }))
    wait.resolve()
    await late
    expect(config()).toMatchObject({ sampleProject: { version: 1, dismissed: true }, unrelated: 'new', futurePreference: { keep: true } })
    expectSaved(writer)
    await expect(sample.readSampleProjectShown('u')).resolves.toBe(false)
  })

  it.each(writers.filter((writer) => writer.name !== 'hint dismissal'))('$name merges after another writer creates the initially absent row', async (writer) => {
    const wait = deferred()
    io.readWait = wait.promise
    const late = writer.write(client)
    await sample.dismissSampleProject('u')
    wait.resolve()
    await late
    expect(config()).toMatchObject({ sampleProject: { version: 1, dismissed: true } })
    expectSaved(writer)
  })

  it('unions simultaneous hint dismissals using the successful retry value', async () => {
    io.rows.set('u/user', { user_id: 'u', scope: 'user', updated_at: '2026-10-29T00:00:00.000Z', config: { firstRunHints: { version: 1, dismissed: [] } } })
    const values = await Promise.all([hints.dismissFirstRunHints('u', ['assistant']), hints.dismissFirstRunHints('u', ['collaboration'])])
    expect(config().firstRunHints).toEqual({ version: 1, dismissed: ['assistant', 'collaboration'] })
    expect(values[1]).toEqual(config().firstRunHints)
  })

  it('does not reset hints enrolled while an older enrollment read was pending', async () => {
    const wait = deferred()
    io.readWait = wait.promise
    const late = hints.startFirstRunHints('u')
    await updateUserSettingsConfig(client, 'u', 'user', (value) => ({ ...value, firstRunHints: { version: 1, dismissed: ['assistant'] } }))
    wait.resolve()
    await late
    expect(config().firstRunHints).toEqual({ version: 1, dismissed: ['assistant'] })
  })

  it('merges simultaneous storage field edits and preserves unknown fields', async () => {
    io.rows.set('u/user', { user_id: 'u', scope: 'user', updated_at: '2026-10-29T00:00:00.000Z', config: { file_storage: { later_key: { keep: true } } } })
    const values = await Promise.all([files.writeFileStorage('u', { retention: '1d' }), files.writeFileStorage('u', { proactive_upload: true })])
    expect(config().file_storage).toMatchObject({ retention: '1d', proactive_upload: true, later_key: { keep: true } })
    expect(values[1]).toMatchObject({ retention: '1d', proactive_upload: true })
  })

  it('preserves another device project choice during a concurrent device edit', async () => {
    await Promise.all([rememberAgentCreateProject(client, 'u', 'other', 'project'), rememberAgentCreateDevice(client, 'u', 'device')])
    expect(config().agent_create).toMatchObject({ device_id: 'device', project_by_device: { other: 'project' } })
  })

  it('keeps profile fields saved while occupation selection was pending', async () => {
    io.rows.set('u/user', { user_id: 'u', scope: 'user', updated_at: '2026-10-29T00:00:00.000Z', config: { profile: { occupation: 'student', later_field: 'old' } } })
    const wait = deferred()
    io.readWait = wait.promise
    const late = firstRun.writeOccupation('u', { key: 'research' })
    await updateUserSettingsConfig(client, 'u', 'user', (value) => ({ ...value, profile: { occupation: 'student', later_field: 'new' } }))
    wait.resolve()
    await late
    expect(config().profile).toEqual({ occupation: 'research', later_field: 'new' })
  })
})
