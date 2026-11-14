import { appendFile, lstat, mkdir, open, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { TYPING_DIAGNOSTICS_BYTES, TYPING_DIAGNOSTICS_FILES } from '../shared/beta-typing-diagnostics'

export type TypingWriteResult = { accepted: true; records: number } | { accepted: false; reason: 'busy' | 'storage' | 'oversize' }
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT'

/** One serialized async writer. Only these fixed slots belong to the recorder. */
export function createTypingDiagnosticsFile(directory: string, options: { maxBytes?: number; files?: number } = {}) {
  const files = options.files ?? TYPING_DIAGNOSTICS_FILES
  const fileBytes = Math.floor((options.maxBytes ?? TYPING_DIAGNOSTICS_BYTES) / files)
  if (!Number.isSafeInteger(files) || files < 1 || !Number.isSafeInteger(fileBytes) || fileBytes < 1) throw new Error('Invalid diagnostic capacity')
  const path = (index: number) => join(directory, `typing-${index}.jsonl`)
  let size = 0, initialized = false, failed = false, queued = 0
  let pending: Promise<unknown> = Promise.resolve()
  const remove = async (file: string) => { try { await unlink(file) } catch (error) { if (!missing(error)) throw error } }
  const rotate = async () => {
    await remove(path(files - 1))
    for (let index = files - 1; index > 0; index--) {
      try { await rename(path(index - 1), path(index)) } catch (error) { if (!missing(error)) throw error }
    }
    size = 0
  }
  const initialize = async () => {
    if (initialized) return
    await mkdir(directory, { recursive: true, mode: 0o700 })
    for (let index = 0; index < files; index++) {
      try {
        const info = await lstat(path(index))
        if (!info.isFile() || info.isSymbolicLink()) throw new Error('Invalid diagnostic slot')
        if (info.size > fileBytes) await remove(path(index))
        else if (index === 0) size = info.size
      } catch (error) { if (!missing(error)) throw error }
    }
    // A crash may leave an incomplete last line. Preserve it in the ring, never join new JSON to it.
    if (size) {
      const file = await open(path(0), 'r')
      const tail = Buffer.alloc(1)
      try { await file.read(tail, 0, 1, size - 1) } finally { await file.close() }
      if (tail[0] !== 10) await rotate()
    }
    initialized = true
  }
  const write = async (lines: string[]) => {
    await initialize()
    let chunk = '', bytes = 0
    const flush = async () => {
      if (!bytes) return
      await appendFile(path(0), chunk, { encoding: 'utf8', mode: 0o600 })
      size += bytes; chunk = ''; bytes = 0
    }
    for (const line of lines) {
      const length = Buffer.byteLength(line)
      if (size + bytes + length > fileBytes) { await flush(); await rotate() }
      chunk += line; bytes += length
    }
    await flush()
  }
  return {
    get failed() { return failed },
    append(records: ReadonlyArray<Record<string, unknown>>): Promise<TypingWriteResult> {
      if (failed) return Promise.resolve({ accepted: false, reason: 'storage' })
      if (queued >= 8) return Promise.resolve({ accepted: false, reason: 'busy' })
      const lines = records.map(record => JSON.stringify(record) + '\n')
      if (lines.some(line => Buffer.byteLength(line) > Math.min(fileBytes, 64_000)) || lines.reduce((sum, line) => sum + Buffer.byteLength(line), 0) > 256_000) return Promise.resolve({ accepted: false, reason: 'oversize' })
      queued++
      const task = pending.then(async (): Promise<TypingWriteResult> => {
        if (failed) return { accepted: false, reason: 'storage' }
        try { await write(lines); return { accepted: true, records: lines.length } }
        catch { failed = true; return { accepted: false, reason: 'storage' } }
      }).finally(() => { queued-- })
      pending = task
      return task
    },
    drain: () => pending,
  }
}
