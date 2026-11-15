import {
  readUserSettingsConfig,
  updateUserSettingsConfig,
  updateUserSettingsKey,
  type SettingsTableClient,
  type VersionedSettingsTableClient,
} from '@gugu/core/cloud/userSettings'
import type { GuguSettingsRow, GuguSettingsScope } from '@gugu/core/shared/types/chat'
import { replica, replicaAccount } from './replica'
import { identityDb } from './supabase'

const client = identityDb as unknown as SettingsTableClient & VersionedSettingsTableClient
type Scope = GuguSettingsScope

const readRow = (userId: string, scope: Scope) => readUserSettingsConfig(client, userId, scope)
const isChatScope = (scope: Scope) => scope.startsWith('chat:')

/**
 * The signed-in account's own settings rows (identity.user_settings), one reading per scope. Occupation, first-run
 * progress and hints, file storage, the product tour and the sample project are keys of the `user` row: their readers
 * share one read (a read on its way serves everyone who asks meanwhile), and a write puts the row the server saved back,
 * so the next reader needs no read at all.
 */
export const ownSettings = replica({
  name: 'ownSettings',
  scope: 'account',
  read: readRow,
  fresh: 10_000,
  // The `user` row's display values (an occupation, which hints were seen): their first frame after a restart. Other
  // scopes are not drawn at start; a group's row is the other model's (sharing the slots, every group opened pushed the
  // `user` row out of the snapshot after four).
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
