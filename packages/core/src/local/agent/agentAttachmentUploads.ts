// An agent's file whose message went out before its bytes (message_send_file) is finished by its host, not by the tool
// call alone: if that call gives up, or the host process dies, the host uploads the bytes later, from where the file is
// on this machine. What is still to upload is the server's answer (pending), as for the composer; this keeps only where
// the bytes are and the upload they were going up under, because the server cannot know a path on this machine and an
// agent's file is no copy in the renderer's cache (a server-mode host has no renderer at all). No bytes are kept here,
// and a file is read again only after its sha256 is checked against what the message declared: a file changed since is
// never sent in its place. The tool and this host run in one process (the MCP server is in the main process; agents
// that need stdio reach it through a relay), so "being uploaded" is the in-process table below.
import { openAsBlob } from 'node:fs'
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  finishDeclaredAttachment, pendingAttachmentUploads, retryableAttachmentError, type AttachmentsEndpoint, type AttachmentUploadPlan,
} from '../../cloud/attachmentsApi'
import { requireAgentFileAccess } from '../state/agentFileBoundary'
import { fileSha256 } from './sessionFileHandoff'

/** Where one sent message's bytes are on this machine, whose send it was, and the upload they last went up under. */
export type AgentUploadRecord = {
  account: string; message_id: string; path: string; sha256: string; size_bytes: number; content_type: string; file_name: string
  keep?: 'temporary'
  plan?: AttachmentUploadPlan
}
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
/** One upload per message, whether the tool call or the host started it. */
const running = new Map<string, Promise<void>>()
let host: AgentUploadHost | null = null
let again: { timer: ReturnType<typeof setTimeout>; delay: number } | null = null

const directory = (home: string) => join(home, 'agent-attachment-uploads')
const recordPath = (home: string, messageId: string) => join(directory(home), `${encodeURIComponent(messageId)}.json`)

/** The host that finishes what a tool call could not (the main process). */
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
async function read(home: string, messageId: string): Promise<AgentUploadRecord | null> {
  try { return JSON.parse(await readFile(recordPath(home, messageId), 'utf8')) as AgentUploadRecord } catch { return null }
}

export function rememberAgentUpload(home: string, record: AgentUploadRecord): Promise<void> {
  return change(record.message_id, () => write(home, record))
}

/**
 * The multipart upload the bytes are going up under now: a later attempt goes on with it instead of sending every part
 * again. A one-request plan is not kept: a failed one is replaced anyway (it may have lapsed, or its object be half written).
 */
export function noteAgentUploadPlan(home: string, messageId: string, plan: AttachmentUploadPlan): Promise<void> {
  if (!plan.parts) return Promise.resolve()
  return change(messageId, async () => {
    const record = await read(home, messageId)
    if (record) await write(home, { ...record, plan })
  })
}

export function forgetAgentUpload(home: string, messageId: string): Promise<void> {
  return change(messageId, () => rm(recordPath(home, messageId), { force: true }))
}

/** Runs one message's upload, unless one is already running (then it is that one). */
export function runAgentUpload(messageId: string, work: () => Promise<void>): Promise<void> {
  const current = running.get(messageId)
  if (current) return current
  const run = work().finally(() => running.delete(messageId))
  running.set(messageId, run)
  return run
}

/**
 * After a failed upload: one the server refused (4xx: not this file, no longer waiting, over the limit) is dropped and
 * never tried again; anything else is for the host to try again (the caller schedules it). True when it is.
 */
export async function agentUploadFailed(home: string, messageId: string, error: unknown): Promise<boolean> {
  if (retryableAttachmentError(error)) return true
  await forgetAgentUpload(home, messageId)
  host?.log.error({ messageId, error: String(error) }, 'agent upload refused; not tried again')
  return false
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
 * The server's list of this account's declared attachments still waiting for bytes, against this machine's records:
 * each one this machine holds for the signed-in account, and that is not already being uploaded, is checked and goes on
 * under its last upload (a fresh one when that is gone), one at a time. A record the server no longer lists (finished,
 * or refused) is dropped; another account's records are left as they are.
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
  const listed = new Map(pending.map(row => [row.message_id, row]))
  let retry = false
  for (const record of mine) {
    if (record.account !== signed.account) continue
    const row = listed.get(record.message_id)
    if (!row) { await forgetAgentUpload(home, record.message_id); continue }
    if (running.has(record.message_id)) continue
    await runAgentUpload(record.message_id, async () => {
      let source: string
      try {
        source = await requireAgentFileAccess(record.path)
        const info = await stat(source)
        if (!info.isFile() || info.size !== row.size_bytes || await fileSha256(source) !== row.sha256) throw new Error('changed')
      } catch (error) {
        // Never other bytes in its place: readers see the attachment failed once its reading deadline passes.
        current.log.error({ messageId: record.message_id, reason: (error as NodeJS.ErrnoException).code ?? (error as Error).message },
          'agent upload source is gone or changed; its bytes are not sent')
        await forgetAgentUpload(home, record.message_id)
        return
      }
      const bytes = await openAsBlob(source, { type: row.content_type })
      await finishDeclaredAttachment(signed.endpoint, { staging_key: row.staging_key, size_bytes: row.size_bytes, plan: record.plan },
        { bytes, name: row.file_name ?? record.file_name, contentType: row.content_type }, { id: row.message_id, chat_id: row.chat_id, as: row.as },
        { ...(record.keep ? { keep: record.keep } : {}), onPlan: plan => { void noteAgentUploadPlan(home, record.message_id, plan) } })
      await forgetAgentUpload(home, record.message_id)
      current.log.info({ messageId: record.message_id }, 'agent upload finished by the host')
    }).catch(async (error) => {
      if (await agentUploadFailed(home, record.message_id, error)) retry = true
      current.log.warn({ messageId: record.message_id, error: String(error) }, 'agent upload failed')
    })
  }
  if (retry) resumeAgentUploadsSoon()
  else if (again) { clearTimeout(again.timer); again = null }
}
