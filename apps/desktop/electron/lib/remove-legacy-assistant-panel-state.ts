import fs from 'node:fs'
import path from 'node:path'

type MigrationLog = {
  info: (message: string, fields?: Record<string, unknown>) => void
  warn: (message: string, fields?: Record<string, unknown>) => void
}

/**
 * gd#1635: startup migration for the removed host-side assistant panel runtime. It deletes only what that
 * runtime wrote under GUGU_HOME: its rejected-body ledger directory and its per-account resource-change
 * journals (`resources-<sha256>.json`). The overflow index beside them (`index-<sha256>.md`) is still in use.
 * Retire this migration once rollback to releases that still contain the runtime is retired.
 */
export function removeLegacyAssistantPanelState(guguHome: string, log: MigrationLog): { removed: number; failed: number } {
  const targets = [path.join(guguHome, 'assistant-panel-body-failures')]
  const journals = path.join(guguHome, 'assistant-resource-state')
  try {
    for (const name of fs.readdirSync(journals)) {
      if (/^resources-[0-9a-f]{64}\.json(?:\.[0-9a-f-]{36}\.tmp)?$/.test(name)) targets.push(path.join(journals, name))
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') log.warn('Assistant panel migration could not inspect its directory', { directory: journals, error: String(error) })
  }
  let removed = 0, failed = 0
  for (const target of targets) {
    if (!fs.existsSync(target)) continue
    try { fs.rmSync(target, { recursive: true, force: true }); removed += 1 }
    catch (error) {
      failed += 1
      log.warn('Assistant panel migration could not remove a legacy path; retry on next startup', { path: target, error: String(error) })
    }
  }
  if (removed > 0) log.info('Assistant panel migration removed legacy state', { removed, failed })
  return { removed, failed }
}
