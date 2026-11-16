// An agent's file whose message went out before its bytes (message_send_file) is finished by its host, not by the tool
// call alone: if that call gives up, or its process dies, the host uploads the bytes later, from where the file is on
// this machine. What is still to upload is the server's answer (pending), as for the composer; this keeps only where the
// bytes are, because the server cannot know a path on this machine and an agent's file is no copy in the renderer's
// cache (a server-mode host has no renderer at all). No bytes are kept here, and a file is read again only after its
// sha256 is checked against what the message declared: a file changed since is never sent in its place.
import { openAsBlob } from 'node:fs'
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { finishDeclaredAttachment, pendingAttachmentUploads, type AttachmentsEndpoint } from '../../cloud/attachmentsApi'
import { requireAgentFileAccess } from '../state/agentFileBoundary'
import { resolveGuguHome } from '../state/paths'
import { fileSha256 } from './sessionFileHandoff'

/** Where one sent message's bytes are on this machine, and whose send it was. */
export type AgentUploadRecord = {
  account: string; pid: number; message_id: string; path: string; sha256: string; size_bytes: number; content_type: string; file_name: string
  keep?: 'temporary'
}
export type AgentUploadHost = {
  /** The signed-in account and an endpoint that may send signed parts; null while signed out. */
  signedIn(): Promise<{ account: string; endpoint: AttachmentsEndpoint } | null>
  log: { info(fields: Record<string, unknown>, message: string): void; warn(fields: Record<string, unknown>, message: string): void; error(fields: Record<string, unknown>, message: string): void }
}

/** A failed upload is tried again by the host, first after this long, then twice as long each time, at most a minute apart. */
const RETRY_FIRST_MS = 5_000
const RETRY_MAX_MS = 60_000
/** One upload per message in this process, whether the tool call or the host started it. */
const running = new Map<string, Promise<void>>()
let host: AgentUploadHost | null = null
let again: { timer: ReturnType<typeof setTimeout>; delay: number } | null = null

const directory = (env: NodeJS.ProcessEnv = process.env) => join(resolveGuguHome(env), 'agent-attachment-uploads')
const recordPath = (messageId: string) => join(directory(), `${encodeURIComponent(messageId)}.json`)

/** The process that runs the host's retries (the main process); a tool call in another process only writes records. */
export function setAgentUploadHost(next: AgentUploadHost | null): void {
  host = next
  if (!next && again) { clearTimeout(again.timer); again = null }
}

export async function rememberAgentUpload(record: Omit<AgentUploadRecord, 'pid'>): Promise<void> {
  await mkdir(directory(), { recursive: true })
  const file = recordPath(record.message_id), partial = `${file}.${process.pid}.tmp`
  await writeFile(partial, JSON.stringify({ ...record, pid: process.pid }))
  await rename(partial, file)
}

/** The tool call gave up on it: any host may now upload it (a live writer no longer owns it). */
export async function releaseAgentUpload(messageId: string): Promise<void> {
  const file = recordPath(messageId)
  let record: AgentUploadRecord
  try { record = JSON.parse(await readFile(file, 'utf8')) as AgentUploadRecord } catch { return }
  const partial = `${file}.${process.pid}.tmp`
  await writeFile(partial, JSON.stringify({ ...record, pid: 0 }))
  await rename(partial, file)
}

export async function forgetAgentUpload(messageId: string): Promise<void> {
  await rm(recordPath(messageId), { force: true })
}

/** Runs one message's upload, unless one is already running in this process (then it is that one). */
export function runAgentUpload(messageId: string, work: () => Promise<void>): Promise<void> {
  const current = running.get(messageId)
  if (current) return current
  const run = work().finally(() => running.delete(messageId))
  running.set(messageId, run)
  return run
}

/** Another live process wrote this record: its own tool call is still on it. */
function ownedElsewhere(pid: number): boolean {
  if (pid === 0 || pid === process.pid) return false
  try { process.kill(pid, 0); return true } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM' }
}

async function records(): Promise<AgentUploadRecord[]> {
  let names: string[]
  try { names = await readdir(directory()) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const found: AgentUploadRecord[] = []
  for (const name of names.filter(n => n.endsWith('.json'))) {
    try { found.push(JSON.parse(await readFile(join(directory(), name), 'utf8')) as AgentUploadRecord) } catch { /* a record mid-write: the next round reads it */ }
  }
  return found
}

/** The host tries again by itself: after a failed upload, or a pending list that could not be read. */
export function resumeAgentUploadsSoon(): void {
  if (!host) return
  const delay = Math.min(again ? again.delay * 2 : RETRY_FIRST_MS, RETRY_MAX_MS)
  if (again) clearTimeout(again.timer)
  again = { delay, timer: setTimeout(() => { void resumeAgentUploads().catch(() => undefined) }, delay) }
  again.timer.unref?.()
}

/**
 * The server's list of this account's declared attachments still waiting for bytes, against this machine's records:
 * each one this machine holds, for the signed-in account and not owned by another live process, is checked and
 * uploaded again under a new plan. A record the server no longer lists (finished, or refused) is dropped.
 */
export async function resumeAgentUploads(): Promise<void> {
  const current = host
  if (!current) return
  const mine = await records()
  if (!mine.length) { if (again) { clearTimeout(again.timer); again = null } return }
  const signed = await current.signedIn()
  if (!signed) return
  let pending
  try { pending = await pendingAttachmentUploads(signed.endpoint) } catch (error) {
    current.log.warn({ error: String(error) }, 'pending agent uploads not read')
    resumeAgentUploadsSoon()
    return
  }
  const listed = new Map(pending.map(row => [row.message_id, row]))
  let failed = false
  await Promise.all(mine.map(async (record) => {
    // Another account's send stays as it is: not uploaded, not dropped.
    if (record.account !== signed.account || ownedElsewhere(record.pid)) return
    const row = listed.get(record.message_id)
    if (!row) { await forgetAgentUpload(record.message_id); return }
    if (running.has(record.message_id)) return
    await runAgentUpload(record.message_id, async () => {
      let source: string
      try {
        source = await requireAgentFileAccess(record.path)
        const info = await stat(source)
        if (!info.isFile() || info.size !== row.size_bytes || await fileSha256(source) !== row.sha256) throw new Error('changed')
      } catch (error) {
        // Never other bytes in its place: the message reads failed when its deadline passes.
        current.log.error({ messageId: record.message_id, reason: (error as NodeJS.ErrnoException).code ?? (error as Error).message },
          'agent upload source is gone or changed; its bytes are not sent')
        await forgetAgentUpload(record.message_id)
        return
      }
      const bytes = await openAsBlob(source, { type: row.content_type })
      await finishDeclaredAttachment(signed.endpoint, { staging_key: row.staging_key, size_bytes: row.size_bytes, plan: undefined },
        { bytes, name: row.file_name ?? record.file_name, contentType: row.content_type }, { id: row.message_id, chat_id: row.chat_id, as: row.as },
        record.keep ? { keep: record.keep } : {})
      await forgetAgentUpload(record.message_id)
      current.log.info({ messageId: record.message_id }, 'agent upload finished by the host')
    }).catch((error) => {
      failed = true
      current.log.warn({ messageId: record.message_id, error: String(error) }, 'agent upload failed; the host tries again')
    })
  }))
  if (failed) resumeAgentUploadsSoon()
  else if (again) { clearTimeout(again.timer); again = null }
}
