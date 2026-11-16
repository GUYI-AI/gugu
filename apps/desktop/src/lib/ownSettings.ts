import {
  readUserSettingsConfig,
  updateUserSettingsConfig,
  updateUserSettingsKey,
  type SettingsTableClient,
  type VersionedSettingsTableClient,
} from '@gugu/core/cloud/userSettings'
import type { GuguSettingsRow, GuguSettingsScope } from '@gugu/core/shared/types/chat'
import { replica, replicaAccount, useReplica, type Reading } from './replica'
import { identityDb } from './supabase'

const client = identityDb as unknown as SettingsTableClient & VersionedSettingsTableClient
type Scope = GuguSettingsScope

const readRow = (userId: string, scope: Scope) => readUserSettingsConfig(client, userId, scope)
const isChatScope = (scope: Scope) => scope.startsWith('chat:')

/** The signed-in account's own settings rows (identity.user_settings), one reading per scope; a write puts the saved row back. */
export const ownSettings = replica({
  name: 'ownSettings',
  scope: 'account',
  read: readRow,
  fresh: 10_000,
  // A transient failure is read again quietly (1 s, 2 s, 4 s): first-run hints, the tour and the occupation hide while the
  // row is unknown, and one failed read would otherwise hide them until something else reads the row.
  retry: 3,
  retryDelay: (attempt: number) => Math.min(1000 * 2 ** attempt, 30_000),
  // Only the `user` row's display values (their first frame); a group's row is the other model's.
  persist: { maxBytes: 1024, maxEntries: 1, carry: (config: Record<string, unknown>, scope: Scope) => (scope === 'user' ? config : undefined) },
})

/** A group's own row (its pinned topics): a cold-opened group draws its pins from the first frame. */
export const chatOwnSettings = replica({
  name: 'chatOwnSettings',
  scope: 'account',
  read: readRow,
  fresh: 10_000,
  persist: { maxBytes: 1024, maxEntries: 4 },
})

const modelOf = (scope: Scope) => (isChatScope(scope) ? chatOwnSettings : ownSettings)

const mine = (userId: string) => replicaAccount().id === userId

/** One row's config. The replica holds the signed-in account's rows; any other id reads the table. */
export function readOwnSettings(userId: string, scope: Scope): Promise<Record<string, unknown>> {
  return mine(userId) ? modelOf(scope).fetch(scope) : readRow(userId, scope)
}

function saved(userId: string, row: GuguSettingsRow): GuguSettingsRow {
  if (mine(userId)) modelOf(row.scope).set([row.scope], row.config)
  return row
}

/** Reapply an edit to the latest row (core's versioned write), then keep the saved row. */
export async function updateOwnSettings(userId: string, scope: Scope, edit: (config: Record<string, unknown>) => Record<string, unknown>) {
  return saved(userId, await updateUserSettingsConfig(client, userId, scope, edit))
}

/** Edit one key of the latest row, then keep the saved row. */
export async function updateOwnSettingsKey(userId: string, scope: Scope, key: string, edit: (value: unknown) => unknown) {
  return saved(userId, await updateUserSettingsKey(client, userId, scope, key, edit))
}

/** One key family of the `user` row, parsed; a value `parse` rejects is an error (❌ "never set"). `userId` null = unknown. */
export function useOwnUserSetting<T>(userId: string | null, parse: (config: Record<string, unknown>) => T): Reading<T> {
  const row = useReplica(ownSettings, userId ? ['user'] : null)
  if (row.state !== 'value') return row
  try {
    return { ...row, value: parse(row.value) }
  } catch (error) {
    return { state: 'error', error: error as Error }
  }
}
