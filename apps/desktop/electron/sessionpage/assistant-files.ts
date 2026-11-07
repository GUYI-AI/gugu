import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
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

export async function preserveDamagedAssistantSettings(path: string): Promise<void> {
  const backup = `${path}.damaged-${new Date().toISOString().replaceAll(':', '-')}-${randomUUID()}`
  try { await rename(path, backup) }
  catch (cause) { throw new AssistantFileError(path, 'backup', cause) }
}
