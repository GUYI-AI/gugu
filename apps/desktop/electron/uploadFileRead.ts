import { stat } from 'node:fs/promises'
import { requireAgentFileAccess } from '@gugu/core/local/state/agentFileBoundary'

/** A local source failed before declaration. Never use this for an upload or commit transport error. */
export class FileUnreadableError extends Error {
  readonly code = 'file_unreadable'
  readonly reason: string

  constructor(path: string, cause: unknown, reason?: string) {
    const code = (cause as NodeJS.ErrnoException | null)?.code
    const name = cause instanceof Error && cause.name !== 'Error' ? cause.name : 'READ_FAILED'
    const why = reason ?? (typeof code === 'string' ? code : name)
    super(`file_unreadable: cannot read ${path} (${why}: ${cause instanceof Error ? cause.message : String(cause)})`, { cause })
    this.name = 'FileUnreadableError'
    this.reason = why
  }
}

/** Only wrap local I/O: later declaration, queue and commit errors must keep their own meaning. */
export async function readUploadFile<T>(path: string, read: () => Promise<T>): Promise<T> {
  try { return await read() }
  catch (error) { throw error instanceof FileUnreadableError ? error : new FileUnreadableError(path, error) }
}

export async function uploadFileInfo(path: string): Promise<{ target: string; size: number }> {
  const target = await requireAgentFileAccess(path).catch((error: unknown) => {
    // Private-storage policy refusals stay intact; an OS refusal resolving the source is a file read failure.
    if (typeof (error as NodeJS.ErrnoException | null)?.code !== 'string') throw error
    throw new FileUnreadableError(path, error)
  })
  const info = await readUploadFile(target, () => stat(target))
  if (!info.isFile()) throw new FileUnreadableError(target, new Error('not a regular file'), 'NOT_A_FILE')
  return { target, size: info.size }
}
