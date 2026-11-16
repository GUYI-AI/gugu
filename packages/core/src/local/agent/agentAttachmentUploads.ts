// The one uploader of an agent's file whose message went out before its bytes (message_send_file). The tool call and the
// host's resume both go through uploadAgentFile: the tool asks for its own message and waits for that upload alone; the
// host, on start and on every reconnect, asks for each one this machine still holds. The MCP server runs in the main
// process (agents that need stdio reach it through a relay), so one main process owns every upload: there is no hand-off
// between processes, and one message's upload never runs twice at once.
//
// What is still to upload is the server's answer (pending), as for the composer; the record kept here only says where
// the bytes are on this machine and the upload they were going up under, because the server cannot know a path on this
// machine and the host may die mid-upload. No bytes are kept, and a file is read only after its size and sha256 are
// checked against what the message declared: a file changed since is never sent in its place.
import { openAsBlob } from 'node:fs'
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  finishDeclaredAttachment, pendingAttachmentUploads, retryableAttachmentError, type AttachmentsEndpoint, type AttachmentUploadPlan,
} from '../../cloud/attachmentsApi'
import { requireAgentFileAccess } from '../state/agentFileBoundary'
import { fileSha256 } from './sessionFileHandoff'

/** One sent message's declared bytes: where they are on this machine, whose send it was, and the upload they go up under. */
export type AgentUploadRecord = {
  account: string; message_id: string; chat_id: string; as: string; staging_key: string
  path: string; sha256: string; size_bytes: number; content_type: string; file_name: string
  keep?: 'temporary'
  plan?: AttachmentUploadPlan
}
/** What became of one upload: finished; to be tried again by the host; refused by the server; or its source changed. */
export type AgentUploadResult = { status: 'finished' } | { status: 'retrying' | 'refused'; error: unknown } | { status: 'changed'; reason: string }
export type AgentUploadHost = {
  /** This host's GUGU_HOME: the records live in it (the tool writes them under its context's same home). */
  home: string
  /** The signed-in account and an endpoint that may send signed parts; null while signed out. */
  signedIn(): Promise<{ account: string; endpoint: AttachmentsEndpoint } | null>
  log: { info(fields: Record<string, unknown>, message: string): void; warn(fields: Record<string, unknown>, message: string): void; error(fields: Record<string, unknown>, message: string): void }
}

/** A failed upload is tried again by the host, first after this long, then twice as long each time, at most a minute apart. */
const RETRY_FIRST_MS = 5_000
const RETRY_MAX_MS = 60_000
const uploading = new Map<string, Promise<AgentUploadResult>>()
let host: AgentUploadHost | null = null
let again: { timer: ReturnType<typeof setTimeout>; delay: number } | null = null

const directory = (home: string) => join(home, 'agent-attachment-uploads')
const recordPath = (home: string, messageId: string) => join(directory(home), `${encodeURIComponent(messageId)}.json`)

/** The host that tries again by itself (the main process). */
export function setAgentUploadHost(next: AgentUploadHost | null): void {
  host = next
  if (!next && again) { clearTimeout(again.timer); again = null }
}

/** One message's record changes in order: a plan noted while uploading never lands after the record is forgotten. */
const changes = new Map<string, Promise<void>>()
function change(messageId: string, work: () => Promise<void>): Promise<void> {
  const next = (changes.get(messageId) ?? Promise.resolve()).then(work, work)
  changes.set(messageId, next)
  void next.finally(() => { if (changes.get(messageId) === next) changes.delete(messageId) }).catch(() => undefined)
  return next
}
async function write(home: string, record: AgentUploadRecord): Promise<void> {
  await mkdir(directory(home), { recursive: true })
  const file = recordPath(home, record.message_id), partial = `${file}.${process.pid}.tmp`
  await writeFile(partial, JSON.stringify(record))
  await rename(partial, file)
}

/** Before the message is committed: where its bytes are. A one-request plan is not kept (a failed one is replaced anyway). */
export function rememberAgentUpload(home: string, record: AgentUploadRecord): Promise<void> {
  const { plan, ...rest } = record
  return change(record.message_id, () => write(home, plan?.parts ? record : rest))
}
export function forgetAgentUpload(home: string, messageId: string): Promise<void> {
  return change(messageId, () => rm(recordPath(home, messageId), { force: true }))
}
function notePlan(home: string, messageId: string, plan: AttachmentUploadPlan): void {
  if (!plan.parts) return
  void change(messageId, async () => {
    const record = await readFile(recordPath(home, messageId), 'utf8').then(text => JSON.parse(text) as AgentUploadRecord, () => null)
    if (record) await write(home, { ...record, plan })
  })
}

/**
 * Uploads one message's bytes from where they are, under its last upload (a fresh one when that is gone), and forgets
 * the record once the server has them, or refused them, or the source no longer matches. A message already uploading is
 * that same upload. A failure worth trying again leaves the record and has the host try again later.
 */
export function uploadAgentFile(home: string, record: AgentUploadRecord, endpoint: AttachmentsEndpoint): Promise<AgentUploadResult> {
  const id = record.message_id, current = uploading.get(id)
  if (current) return current
  const run = (async (): Promise<AgentUploadResult> => {
    // Never other bytes in its place: readers see the attachment failed once its reading deadline passes.
    const source = await requireAgentFileAccess(record.path).catch((error: unknown) => { host?.log.warn({ messageId: id, error: String(error) }, 'agent upload source not readable'); return null })
    const info = source ? await stat(source).catch(() => null) : null
    const reason = !source ? 'not readable' : !info?.isFile() ? 'gone' : info.size !== record.size_bytes || await fileSha256(source) !== record.sha256 ? 'changed' : null
    if (!source || reason) {
      await forgetAgentUpload(home, id)
      host?.log.error({ messageId: id, reason }, 'agent upload source is gone or changed; its bytes are not sent')
      return { status: 'changed', reason: reason ?? 'not readable' }
    }
    try {
      await finishDeclaredAttachment(endpoint, record, { bytes: await openAsBlob(source, { type: record.content_type }), name: record.file_name, contentType: record.content_type },
        { id, chat_id: record.chat_id, as: record.as }, { ...(record.keep ? { keep: record.keep } : {}), onPlan: plan => notePlan(home, id, plan) })
    } catch (error) {
      if (retryableAttachmentError(error)) {
        host?.log.warn({ messageId: id, error: String(error) }, 'agent upload failed; the host tries again')
        resumeAgentUploadsSoon()
        return { status: 'retrying', error }
      }
      await forgetAgentUpload(home, id)
      host?.log.error({ messageId: id, error: String(error) }, 'agent upload refused; not tried again')
      return { status: 'refused', error }
    }
    await forgetAgentUpload(home, id)
    host?.log.info({ messageId: id }, 'agent upload finished')
    return { status: 'finished' }
  })().finally(() => uploading.delete(id))
  uploading.set(id, run)
  return run
}

async function records(home: string): Promise<AgentUploadRecord[]> {
  let names: string[]
  try { names = await readdir(directory(home)) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const found: AgentUploadRecord[] = []
  for (const name of names.filter(n => n.endsWith('.json'))) {
    try { found.push(JSON.parse(await readFile(join(directory(home), name), 'utf8')) as AgentUploadRecord) } catch { /* a record mid-write: the next round reads it */ }
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
 * The server's list of this account's declared attachments still waiting for bytes, against this machine's records: each
 * one this machine holds for the signed-in account is uploaded, one at a time. A record the server no longer lists
 * (finished, or refused) is dropped; another account's records are left as they are.
 */
export async function resumeAgentUploads(): Promise<void> {
  const current = host
  if (!current) return
  const home = current.home, mine = await records(home)
  if (!mine.length) { if (again) { clearTimeout(again.timer); again = null } return }
  const signed = await current.signedIn()
  if (!signed) return
  let pending
  try { pending = await pendingAttachmentUploads(signed.endpoint) } catch (error) {
    current.log.warn({ error: String(error) }, 'pending agent uploads not read')
    resumeAgentUploadsSoon()
    return
  }
  const listed = new Set(pending.map(row => row.message_id))
  let retry = false
  for (const record of mine) {
    if (record.account !== signed.account) continue
    if (!listed.has(record.message_id)) { await forgetAgentUpload(home, record.message_id); continue }
    if ((await uploadAgentFile(home, record, signed.endpoint)).status === 'retrying') retry = true
  }
  if (!retry && again) { clearTimeout(again.timer); again = null }
}
