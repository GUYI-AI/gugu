import { beforeEach, describe, expect, it, vi } from 'vitest'
import { updateUserSettingsConfig } from '@gugu/core/cloud/userSettings'
import { versionedSettingsClient } from '../../../support/versionedSettingsTestDouble'

const io = vi.hoisted(() => ({ rows: new Map<string, Record<string, unknown>>(), failWrite: false, readWait: null as Promise<void> | null, reads: 0 }))
vi.mock('@/lib/supabase', async () => {
  const { versionedSettingsClient } = await import('../../../support/versionedSettingsTestDouble')
  return { identityDb: versionedSettingsClient(io) }
})
const sample = await import('@/lib/sampleProject')
const { saveProductTourState } = await import('@/lib/productTour')
const client = versionedSettingsClient(io)
const config = () => io.rows.get('u/user')?.config
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}
beforeEach(() => { io.rows.clear(); io.failWrite = false; io.readWait = null; io.reads = 0 })

describe('durable sample removal', () => {
  it('removes only this account sample and keeps the persisted marker across reload, reauthentication and upgrade reads', async () => {
    await sample.enrollSampleProject('u')
    await updateUserSettingsConfig(client, 'u', 'user', (value) => ({ ...value, other: 'keep' }))
    const changed = vi.fn()
    const stop = sample.subscribeSampleProject(changed)
    try {
      await sample.dismissSampleProject('u')
      expect(changed).toHaveBeenCalledWith('u')
      expect(config()).toEqual({ other: 'keep', sampleProject: { version: 1, dismissed: true } })
      for (const lifecycle of ['restart', 'same-account sign-in', 'upgrade']) {
        vi.resetModules()
        const fresh = await import('@/lib/sampleProject')
        await expect(fresh.readSampleProjectShown('u'), lifecycle).resolves.toBe(false)
        await fresh.enrollSampleProject('u')
        await expect(fresh.readSampleProjectShown('u'), lifecycle).resolves.toBe(false)
      }
      await sample.enrollSampleProject('other')
      await expect(sample.readSampleProjectShown('other')).resolves.toBe(true)
    } finally { stop() }
  })

  it('does not let an enrollment read started before removal bring the sample back', async () => {
    const wait = deferred()
    io.readWait = wait.promise
    const enrollment = sample.enrollSampleProject('u')
    await Promise.resolve()
    await updateUserSettingsConfig(client, 'u', 'user', (value) => ({ ...value, sampleProject: { version: 1, dismissed: true } }))
    wait.resolve()
    await enrollment
    await expect(sample.readSampleProjectShown('u')).resolves.toBe(false)
  })

  it('keeps the sample visible and does not notify success when its save fails', async () => {
    await sample.enrollSampleProject('u')
    io.failWrite = true
    const changed = vi.fn()
    const stop = sample.subscribeSampleProject(changed)
    try {
      await expect(sample.dismissSampleProject('u')).rejects.toThrow('write refused')
      expect(changed).not.toHaveBeenCalled()
      await expect(sample.readSampleProjectShown('u')).resolves.toBe(true)
    } finally { stop() }
  })

  // Explicitly documents the deferred C work: A's conditional edit cannot make an
  // unrelated module's later unconditional upsert conditional. This is not coverage
  // of the desired no-resurrection guarantee across all settings writers.
  it.fails('known C gap: a stale whole-config upsert can still overwrite a confirmed dismissal', async () => {
    await sample.enrollSampleProject('u')
    const wait = deferred()
    io.readWait = wait.promise
    const lateProgress = saveProductTourState('u', { step: 'tasks', status: 'active' })
    await Promise.resolve()
    await sample.dismissSampleProject('u')
    expect(config()).toMatchObject({ sampleProject: { dismissed: true } })
    wait.resolve()
    await lateProgress
    await expect(sample.readSampleProjectShown('u')).resolves.toBe(false)
  })
})
