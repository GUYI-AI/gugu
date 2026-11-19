import type Database from 'better-sqlite3'

/** Presence only. Never read a secret value, project path or another account's
 * content merely to describe what the native cleanup deliberately retains. */
export function readDesktopClosureRetainedItems(database: Pick<Database.Database, 'prepare'>,
  files: { logs: boolean; sharedCache: boolean; runtimeLedger: boolean }): string[] {
  const has = (sql: string) => Boolean(database.prepare(sql).get())
  const result: string[] = []
  if (has('SELECT 1 FROM projects LIMIT 1')) result.push('workspace-records')
  if (has('SELECT 1 FROM sessions LIMIT 1')) result.push('unattributed-session-history')
  if (has('SELECT 1 FROM app_settings LIMIT 1')) result.push('device-settings')
  if (has('SELECT 1 FROM provider_accounts LIMIT 1')
    || has("SELECT 1 FROM app_secrets WHERE key NOT LIKE 'account-closure%' LIMIT 1")) result.push('provider-credentials')
  if (files.logs) result.push('unattributed-diagnostic-logs')
  if (files.sharedCache) result.push('shared-file-cache')
  if (files.runtimeLedger) result.push('device-runtime-ledger')
  return result
}
