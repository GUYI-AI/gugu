import { randomUUID } from 'node:crypto'
import { link, mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { AssistantFileError } from '@gugu/core/shared/assistantFileError'

export async function readAssistantFile(path: string): Promise<string | null> {
  try { return await readFile(path, 'utf8') }
  catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw new AssistantFileError(path, 'read', cause)
  }
}

/** Flush bytes before publishing the replacement; a failed write leaves the old file intact. */
export async function writeAssistantFile(path: string, content: string): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    await mkdir(dirname(path), { recursive: true })
    const file = await open(temporary, 'wx', 0o600)
    try {
      await file.writeFile(content, 'utf8')
      await file.sync()
    } finally { await file.close() }
    await rename(temporary, path)
  } catch (cause) {
    await rm(temporary, { force: true }).catch(() => {})
    throw new AssistantFileError(path, 'write', cause)
  }
}

/** Move damaged settings aside, but only the exact bytes the caller judged damaged.
 * Returns false when another writer replaced the file first; that writer's file is left in place. */
export async function preserveDamagedAssistantSettings(path: string, expected: string): Promise<boolean> {
  if (await readAssistantFile(path) !== expected) return false
  const backup = `${path}.damaged-${new Date().toISOString().replaceAll(':', '-')}-${randomUUID()}`
  try { await rename(path, backup) }
  catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw new AssistantFileError(path, 'backup', cause)
  }
  if (await readAssistantFile(backup) === expected) return true
  // The file was replaced between the check and the move. Put the newer content back unless a newer file exists
  // already; link never overwrites, and the moved content stays in the backup if it cannot be restored.
  try { await link(backup, path); await rm(backup) } catch { /* retained as backup */ }
  return false
}
