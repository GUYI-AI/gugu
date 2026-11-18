import { randomUUID } from 'node:crypto'
import { rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Existing startup sweeper recognizes files from a host process that has exited.
export const SESSION_SETTINGS_FILE_PREFIX = 'gugu-platform-settings-'

export async function writeSessionSettingsFile(document: Record<string, unknown>): Promise<string> {
  const path = join(tmpdir(), `${SESSION_SETTINGS_FILE_PREFIX}${process.pid}-${randomUUID().slice(0, 8)}.json`)
  try {
    await writeFile(path, `${JSON.stringify(document)}\n`, { mode: 0o600 })
  } catch (error) {
    await rm(path, { force: true }).catch(() => undefined)
    throw error
  }
  return path
}
