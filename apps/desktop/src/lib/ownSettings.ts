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

/**
 * The signed-in account's own settings rows (identity.user_settings), one reading per scope. Occupation, first-run
 * progress and hints, file storage, the product tour and the sample project are keys of the same rows: their readers
 * share one read (a read on its way serves everyone who asks meanwhile), and a write puts the row the server saved back,
 * so the next reader needs no read at all. A group's own row (`chat:<id>`, its pinned topics) is the replica `chatPins`'s
 * (components/chat/useChatPinSettings): read and kept there, ❌ a second copy of it here.
 */
export const ownSettings = replica({
  name: 'ownSettings',
  scope: 'account',
  read: readRow,
  fresh: 10_000,
  // ❌ A retry here: the data client already reads a failed request again quietly (postgrest-js, 1 s / 2 s / 4 s); a second
  // layer multiplies how long a failure takes to be said (the account page: about 32 s instead of 4 s).
  // Display values (an occupation, which hints were seen, pinned topics): their first frame after a restart.
  persist: { maxBytes: 1024, maxEntries: 4 },
})

/** The replica holds the signed-in account's own rows except a group's (that one is `chatPins`'s). */
const held = (userId: string, scope: Scope) => replicaAccount().id === userId && !isChatScope(scope)

/** One row's config. The replica holds the signed-in account's rows; any other id (or a group's row) reads the table. */
export function readOwnSettings(userId: string, scope: Scope): Promise<Record<string, unknown>> {
  return held(userId, scope) ? ownSettings.fetch(scope) : readRow(userId, scope)
}

function saved(userId: string, row: GuguSettingsRow): GuguSettingsRow {
  if (held(userId, row.scope)) ownSettings.set([row.scope], row.config)
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
