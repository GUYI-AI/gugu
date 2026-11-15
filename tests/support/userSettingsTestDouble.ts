import { expect } from 'vitest'
import type { SettingsTableClient } from '@gugu/core/cloud/userSettings'

// @@@fake-settings-client - mirrors the identity.user_settings surface the real Supabase client
// exposes. Hoisted out of tests/unit/domain/devices/deviceSshConfig.test.ts when #2525 added a
// second consumer (per-user 创建默认值) — one double for one table, so a drift in the real query
// shape breaks both suites at once instead of only the one that was kept up to date.
// Row key is `${userId}::${scope}`, matching the table's (user_id, scope) primary key.

export interface FakeSettingsClient {
  client: SettingsTableClient
  rows: Record<string, Record<string, unknown>>
  upserts: Array<Record<string, unknown>>
}

export function fakeSettingsClient(
  initial: Record<string, Record<string, unknown>> = {}
): FakeSettingsClient {
  const rows: Record<string, Record<string, unknown>> = { ...initial }
  const versions: Record<string, string> = Object.fromEntries(Object.keys(initial).map((key) => [key, '2026-06-06T00:00:00.000Z']))
  // Keep the existing receipt name so business assertions do not change when the write protocol does.
  const upserts: Array<Record<string, unknown>> = []
  const keyOf = (values: Record<string, unknown>) => `${String(values.user_id)}::${String(values.scope)}`
  const save = (values: Record<string, unknown>) => {
    upserts.push(values)
    const key = keyOf(values)
    rows[key] = structuredClone(values.config) as Record<string, unknown>
    versions[key] = String(values.updated_at)
    return { data: { scope: values.scope, config: rows[key], updated_at: versions[key] }, error: null }
  }
  const client: SettingsTableClient = {
    from(table) {
      expect(table).toBe('user_settings')
      return {
        update(values: Record<string, unknown>) {
          const filters: Record<string, string> = {}
          const query = {
            eq(column: 'user_id' | 'scope' | 'updated_at', value: string) { filters[column] = value; return query },
            select(columns: string) {
              expect(columns).toBe('scope, config, updated_at')
              return { async maybeSingle() {
                const key = keyOf(values)
                if (!rows[key] || versions[key] !== filters.updated_at || values.user_id !== filters.user_id || values.scope !== filters.scope) return { data: null, error: null }
                return save(values)
              } }
            },
          }
          return query
        },
        insert(values: Record<string, unknown>) {
          return { select(columns: string) {
            expect(columns).toBe('scope, config, updated_at')
            return { async maybeSingle() {
              if (rows[keyOf(values)]) return { data: null, error: { message: 'duplicate key', code: '23505' } }
              return save(values)
            } }
          } }
        },
        select(columns: string) {
          expect(columns).toBe('scope, config, updated_at')
          return {
            eq(userColumn: 'user_id', userId: string) {
              expect(userColumn).toBe('user_id')
              return {
                eq(scopeColumn: 'scope', scope: string) {
                  expect(scopeColumn).toBe('scope')
                  return {
                    async maybeSingle() {
                      const key = `${userId}::${scope}`
                      const config = rows[key]
                      return {
                        data: config
                          ? { scope, config, updated_at: versions[key] }
                          : null,
                        error: null
                      }
                    }
                  }
                }
              }
            }
          }
        },
        upsert(values: Record<string, unknown>, options: { onConflict: string }) {
          expect(options).toEqual({ onConflict: 'user_id,scope' })
          upserts.push(values)
          const key = `${String(values.user_id)}::${String(values.scope)}`
          rows[key] = values.config as Record<string, unknown>
          versions[key] = String(values.updated_at)
          return {
            select(columns: string) {
              expect(columns).toBe('scope, config, updated_at')
              return {
                async single() {
                  return {
                    data: {
                      scope: values.scope,
                      config: values.config,
                      updated_at: values.updated_at
                    },
                    error: null
                  }
                }
              }
            }
          }
        }
      }
    }
  }
  return { client, rows, upserts }
}
