import { describe, expect, it } from 'vitest'
import { updateUserSettingsKey, type SettingsTableClient } from '@gugu/core/cloud/userSettings'
import { versionedSettingsClient } from '../../../support/versionedSettingsTestDouble'

const initial = () => ({ user_id: 'u', scope: 'user', config: { sampleProject: { version: 1, dismissed: true }, future: { keep: true } }, updated_at: '2026-10-29T00:00:00.000Z' })

describe('single-key versioned settings writes', () => {
  it.each([false, true])('merges simultaneous independent keys without replacing other settings (existing=%s)', async (existing) => {
    const state = { rows: new Map<string, Record<string, unknown>>(), failWrite: false }
    if (existing) state.rows.set('u/user', initial())
    const client = versionedSettingsClient(state)
    await Promise.all([
      updateUserSettingsKey(client, 'u', 'user', 'one', () => 1),
      updateUserSettingsKey(client, 'u', 'user', 'two', () => 2),
    ])
    expect(state.rows.get('u/user')?.config).toEqual({ ...(existing ? initial().config : {}), one: 1, two: 2 })
  })

  it('only writes the requested account and scope', async () => {
    const other = { ...initial(), user_id: 'other' }
    const chat = { ...initial(), scope: 'chat:g' }
    const state = { rows: new Map<string, Record<string, unknown>>([['u/user', initial()], ['other/user', other], ['u/chat:g', chat]]), failWrite: false }
    await updateUserSettingsKey(versionedSettingsClient(state), 'u', 'user', 'one', () => 1)
    expect(state.rows.get('other/user')).toEqual(other)
    expect(state.rows.get('u/chat:g')).toEqual(chat)
    expect(state.rows.get('u/user')?.config).toEqual({ ...initial().config, one: 1 })
  })

  it.each(['read', 'write'] as const)('propagates %s refusal without acknowledging a saved preference', async (phase) => {
    const state = { rows: new Map<string, Record<string, unknown>>([['u/user', initial()]]), failWrite: phase === 'write', failRead: phase === 'read' }
    await expect(updateUserSettingsKey(versionedSettingsClient(state), 'u', 'user', 'one', () => 1)).rejects.toThrow(`${phase} refused`)
    expect(state.rows.get('u/user')).toEqual(initial())
  })

  it('fails after four version conflicts and preserves the concurrent writer', async () => {
    const state = { rows: new Map<string, Record<string, unknown>>([['u/user', initial()]]), failWrite: false, conflicts: 0 }
    const real = versionedSettingsClient(state)
    let edits = 0
    const client: SettingsTableClient = { from(table) {
      const base = real.from(table)
      return { ...base, update(values) {
        const update = base.update(values)
        const query = {
          eq(column: 'user_id' | 'scope' | 'updated_at', value: string) { update.eq(column, value); return query },
          select(columns: string) {
            const result = update.select(columns)
            return { async maybeSingle() {
              // Another device commits between this read and conditional UPDATE on every attempt.
              const row = state.rows.get('u/user')!
              state.rows.set('u/user', { ...row, config: { ...row.config as Record<string, unknown>, concurrent: true }, updated_at: new Date(Date.parse(row.updated_at as string) + 1).toISOString() })
              return result.maybeSingle()
            } }
          },
        }
        return query
      } }
    } }
    await expect(updateUserSettingsKey(client, 'u', 'user', 'one', () => ++edits)).rejects.toThrow('Settings changed on another device; try again')
    expect(edits).toBe(4)
    expect(state.conflicts).toBe(4)
    expect(state.rows.get('u/user')?.config).toEqual({ ...initial().config, concurrent: true })
  })

  it('refuses an invalid row version before writing', async () => {
    const row = { ...initial(), updated_at: 'invalid' }
    const state = { rows: new Map<string, Record<string, unknown>>([['u/user', row]]), failWrite: false }
    await expect(updateUserSettingsKey(versionedSettingsClient(state), 'u', 'user', 'one', () => 1)).rejects.toThrow('Invalid user_settings version')
    expect(state.rows.get('u/user')).toEqual(row)
  })
})
