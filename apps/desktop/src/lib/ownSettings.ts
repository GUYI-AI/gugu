import {
  readUserSettingsConfig,
  updateUserSettingsConfig,
  updateUserSettingsKey,
  type SettingsTableClient,
  type VersionedSettingsTableClient,
} from '@gugu/core/cloud/userSettings'
import type { GuguSettingsRow, GuguSettingsScope } from '@gugu/core/shared/types/chat'
import { readModel, readModelAccount } from './readModel'
import { identityDb } from './supabase'

const client = identityDb as unknown as SettingsTableClient & VersionedSettingsTableClient
type Scope = GuguSettingsScope

/**
 * The signed-in account's own settings rows (identity.user_settings), one reading per scope. Occupation, first-run
 * progress and hints, file storage, the product tour, the sample project and chat pins are keys of the same rows:
 * their readers share one read (a read on its way serves everyone who asks meanwhile), and a write puts the row the
 * server saved back, so the next reader needs no read at all.
 */
export const ownSettings = readModel({
  name: 'ownSettings',
  scope: 'account',
  read: (userId, scope: Scope) => readUserSettingsConfig(client, userId, scope),
  fresh: 10_000,
  // Display values (an occupation, which hints were seen, pinned topics): their first frame after a restart.
  persist: true,
})

const mine = (userId: string) => readModelAccount().id === userId

/** One row's config. The read model holds the signed-in account's rows; any other id reads the table. */
export function readOwnSettings(userId: string, scope: Scope): Promise<Record<string, unknown>> {
  return mine(userId) ? ownSettings.fetch(scope) : readUserSettingsConfig(client, userId, scope)
}

function saved(userId: string, row: GuguSettingsRow): GuguSettingsRow {
  if (mine(userId)) ownSettings.set([row.scope], row.config)
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
