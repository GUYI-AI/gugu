// The attachments function (gugu-supabase supabase/functions/attachments), one client for every host: the renderer, main,
// the agent inbox and the session MCP server all call these (#7290 gugu-3; 统筹 10-17: one copy, in core). Where the
// server is and whose token comes in, every time: the MCP server has its own (its context), the others read this
// build's config (`configuredEndpoint`).
//   upload → the bytes go straight to OSS (a signed form), then
//   commit → sent as a chat message (the file lands in the chat's 「附件」), or
//   place  → only put in the chat's folder (a new file, or a new version of one) — no message;
//   forward → a new-kind attachment message forwarded (the server makes the target's item);
//   urls   → signed links for items' versions or whisper messages.
import { egress } from '../shared/egress'
import { retryFileDownload } from './fileDownloadRetry'
import type { FileKeep } from '../shared/fileStorage'
import { getSupabaseAnonKey, getSupabaseUrl } from './config'
import { sha256 as sha256Hash } from '@noble/hashes/sha2.js'

export type AttachmentByteProgress = { loaded: number; total?: number }
export type AttachmentUploadTransport = (url: string, init: {
  method: 'POST' | 'PUT'; body: Blob | FormData; headers?: Record<string, string>; signal?: AbortSignal
}, onProgress?: (progress: AttachmentByteProgress) => void) => Promise<{ status: number }>

export interface AttachmentsEndpoint {
  supabaseUrl: string
  anonKey: string
  token: string
  fetch?: typeof globalThis.fetch
  upload?: AttachmentUploadTransport
  /**
   * This host can send a server-signed PUT straight to the object store, so it asks for multipart uploads. A main process
   * or the phone host can; a page cannot (the bucket's CORS does not allow signed PUTs from the app origin), so
   * `configuredEndpoint` leaves it unset and its uploads stay one form request.
   */
  signedParts?: boolean
}

/** This build's server (config), with `token`. */
export function configuredEndpoint(token: string): AttachmentsEndpoint {
  return { supabaseUrl: getSupabaseUrl(), anonKey: getSupabaseAnonKey(), token }
}

/** A refusal from the function, with its code (upload_used, version_conflict, too_large, denied, …) — said, never swallowed. */
export class AttachmentsError extends Error {
  /** `details`: only on recipient_not_member — the refused ids, comma-separated in to_user_ids order (gugu-supabase#242). */
  constructor(readonly route: string, readonly status: number, readonly code: string, message: string, readonly details?: string) {
    super(`attachments/${route}: ${message}`)
  }
}

async function call(endpoint: AttachmentsEndpoint, route: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
  signal?.throwIfAborted()
  const url = `${endpoint.supabaseUrl.replace(/\/+$/, '')}/functions/v1/attachments/${route}`
  const request = async () => {
    const response = await (endpoint.fetch ?? egress.fetch)(url, {
      method: 'POST',
      headers: { apikey: endpoint.anonKey, Authorization: `Bearer ${endpoint.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    })
    const text = await response.text()
    let json: unknown = null
    try { json = JSON.parse(text) } catch { /* not json: said below as it is */ }
    if (!response.ok) {
      const said = (json ?? {}) as { error?: unknown; message?: unknown; details?: unknown }
      throw new AttachmentsError(route, response.status, typeof said.error === 'string' ? said.error : 'failed',
        typeof said.message === 'string' ? said.message : `HTTP ${response.status} ${text.slice(0, 200)}`,
        typeof said.details === 'string' ? said.details : undefined)
    }
    return json
  }
  return route === 'file-download' || route === 'file-resolve'
    ? retryFileDownload(() => ({ stage: route === 'file-download' ? 'signature' : 'metadata', url }), request, signal)
    : request()
}

/** The server's scoped plan for one upload (its staging key), before any byte goes up. */
export async function planAttachmentUpload(endpoint: AttachmentsEndpoint, file: { size: number; contentType: string },
  scope: { chat_id: string | null; as: string; request_id?: string }, signal?: AbortSignal): Promise<AttachmentUploadPlan & { staging_key: string }> {
  return await call(endpoint, 'upload', {
    size_bytes: file.size, content_type: file.contentType, as: scope.as, chat_id: scope.chat_id, request_id: scope.request_id ?? crypto.randomUUID(),
    // A host that can send signed part PUTs asks for parts; the server gives them for a file over one part.
    ...(endpoint.signedParts ? { parts: true } : {}),
  }, signal) as AttachmentUploadPlan & { staging_key: string }
}

/**
 * Uploads to the configured object store using the server-issued scoped upload plan. An endpoint with `signedParts` asks
 * for a multipart upload, which the server gives when its store signs parts and the file is more than one part; the same
 * `request_id` then resumes it, sending only the parts not yet stored. A given `request_id` whose permit was used or
 * lapsed starts the upload once more under a fresh id.
 */
export async function uploadAttachmentBytes(
  endpoint: AttachmentsEndpoint,
  file: { bytes: Uint8Array | Blob; name: string; contentType: string },
  scope: { chat_id: string | null; as: string; request_id?: string },
  options?: { onPlan?: (plan: AttachmentUploadPlan) => void; retry?: boolean; onProgress?: (progress: AttachmentByteProgress) => void; signal?: AbortSignal },
): Promise<string> {
  const size = file.bytes instanceof Blob ? file.bytes.size : file.bytes.byteLength
  let requestId = scope.request_id ?? crypto.randomUUID(), fresh = false, restarted = false
  for (;;) {
    try {
      const form = await planAttachmentUpload(endpoint, { size, contentType: file.contentType }, { ...scope, request_id: requestId }, options?.signal)
      options?.onPlan?.(form)
      await uploadAttachmentPlan(endpoint, form, file, options?.retry === true && !!scope.request_id && !fresh, options?.onProgress, options?.signal)
      return form.staging_key
    } catch (error) {
      if (!(error instanceof AttachmentsError)) throw error
      // The parts did not make this file, or the server holds no upload for the key any more: start it again, once.
      if (!restarted && (error.code === 'upload_changed' || error.route === 'upload-parts' && error.code === 'upload_incomplete')) { restarted = true; continue }
      // The caller's id was already sent or its permit lapsed (a resend long after the first try, or a resumed upload that
      // stopped reporting): that id can never upload again, so the upload starts once more under a fresh one.
      if (scope.request_id && !fresh && error.code === 'expired') { fresh = true; restarted = false; requestId = crypto.randomUUID(); continue }
      throw error
    }
  }
}

/** The same request id for the same content from the same sender to the same place, so a later call resumes the upload. */
export async function contentRequestId(...identity: string[]): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(identity.join('\n'))))
  const hex = Array.from(digest.subarray(0, 16), byte => byte.toString(16).padStart(2, '0')).join('')
  // A version 8 (name-based, custom hash) UUID: the server only needs the UUID shape.
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${(8 | parseInt(hex[16]!, 16) & 3).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

type SignedPart = { n: number; bytes: number; url: string; headers: Record<string, string> }
const PART_CONCURRENCY = 3

/**
 * Sends the parts the server asks for, a few at a time, reporting each batch as it goes, then joins them. State lives on
 * the server: a part that is stored is never sent again, including by a later call. A part whose signature expired (403)
 * is signed again; transient failures are retried in the file-read retry window.
 */
async function uploadAttachmentParts(endpoint: AttachmentsEndpoint, key: string, plan: { part_bytes: number; count: number },
  file: { bytes: Uint8Array | Blob; name: string; contentType: string }, onProgress?: (progress: AttachmentByteProgress) => void, signal?: AbortSignal) {
  const blob = file.bytes instanceof Blob ? file.bytes : new Blob([file.bytes as BlobPart], { type: file.contentType })
  const partSize = (n: number) => n < plan.count ? plan.part_bytes : blob.size - (plan.count - 1) * plan.part_bytes
  let report: number[] = [], resigned = false
  for (let joins = 0; ; joins++) {
    for (;;) {
      const answer = await call(endpoint, 'upload-parts', { staging_key: key, done: report }, signal) as { done: number[]; todo: SignedPart[] }
      report = []
      if (!answer.todo.length) break
      const stored = answer.done.reduce((sum, n) => sum + partSize(n), 0), sending = new Map<number, number>()
      const progress = () => onProgress?.({ loaded: stored + report.reduce((sum, n) => sum + partSize(n), 0) + [...sending.values()].reduce((a, b) => a + b, 0), total: blob.size })
      const queue = [...answer.todo]
      let expired = false
      const failures: unknown[] = []
      await Promise.all(Array.from({ length: Math.min(PART_CONCURRENCY, queue.length) }, async () => {
        for (let part = queue.shift(); part && !expired && !failures.length; part = queue.shift()) {
          const sent = part
          const start = (sent.n - 1) * plan.part_bytes
          try {
            const status = await retryFileDownload(() => ({ stage: 'oss', url: sent.url }),
              () => putPart(endpoint, sent, blob.slice(start, start + sent.bytes), loaded => { sending.set(sent.n, loaded); progress() }, signal), signal)
            if (status === 403) { expired = true; return }
            report.push(sent.n)
            progress()
          } catch (error) { failures.push(error) } finally { sending.delete(sent.n) }
        }
      }))
      if (failures.length) {
        // The parts that did go up are reported before giving up, so a later attempt does not send them again. That
        // report failing too changes nothing: the original failure is the one said.
        if (report.length) await call(endpoint, 'upload-parts', { staging_key: key, done: report }, signal).catch(() => undefined)
        throw failures[0]
      }
      // A signature that expired is signed again; one just signed and still refused is a real refusal.
      if (expired && resigned && !report.length) throw new AttachmentsError('upload', 403, 'failed', `storing ${file.name} failed: the storage refused a fresh part signature`)
      resigned = expired
    }
    try {
      await call(endpoint, 'upload-complete', { staging_key: key }, signal)
      return
    } catch (error) {
      // The server says which parts it has not recorded: send those, then join again.
      if (!(error instanceof AttachmentsError) || error.code !== 'upload_incomplete' || joins >= 2) throw error
    }
  }
}

async function putPart(endpoint: AttachmentsEndpoint, part: SignedPart, body: Blob, onLoaded: (loaded: number) => void, signal?: AbortSignal) {
  // The runtime sets content-length from the body, which is exactly the signed length; a hand-set one is refused by fetch.
  const headers = Object.fromEntries(Object.entries(part.headers).filter(([name]) => name.toLowerCase() !== 'content-length'))
  const init = { method: 'PUT' as const, body, headers, signal }
  const sent = endpoint.upload ? await endpoint.upload(part.url, init, progress => onLoaded(progress.loaded))
    : await (endpoint.fetch ?? egress.fetch)(part.url, init).then(async response => { await response.body?.cancel(); return response })
  if (sent.status === 200 || sent.status === 403) return sent.status
  throw new AttachmentsError('upload', sent.status, 'failed', `storing part ${part.n} of ${part.bytes} bytes failed: HTTP ${sent.status}`)
}

export type AttachmentUploadPlan = { expires_at?: string; url: string; fields: Record<string, string>; max_bytes: number; method?: 'POST' | 'PUT'; headers?: Record<string, string>
  /** A multipart plan (no url or fields): its staging key and the parts the server asks for. */
  staging_key?: string; parts?: { part_bytes: number; count: number } }

/** Ordinary and temporary uploads execute the same scoped provider plan; signing remains server-side. */
export async function uploadAttachmentPlan(endpoint: AttachmentsEndpoint, form: AttachmentUploadPlan, file: { bytes: Uint8Array | Blob; name: string; contentType: string }, allowExisting = false, onProgress?: (progress: AttachmentByteProgress) => void, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  const size = file.bytes instanceof Blob ? file.bytes.size : file.bytes.byteLength
  if (size > form.max_bytes) throw new AttachmentsError('upload', 413, 'too_large', `${file.name} is ${size} bytes; a file is at most ${form.max_bytes}`)
  if (form.parts) {
    if (!form.staging_key) throw new AttachmentsError('upload', 502, 'invalid', 'a multipart upload plan without its staging key')
    return uploadAttachmentParts(endpoint, form.staging_key, form.parts, file, onProgress, signal)
  }
  const method = form.method ?? 'POST'
  if (method !== 'POST' && method !== 'PUT') throw new AttachmentsError('upload', 502, 'invalid', 'unsupported upload method')
  const blob = file.bytes instanceof Blob ? file.bytes : new Blob([file.bytes as BlobPart], { type: file.contentType })
  let body: Blob | FormData = blob
  if (method === 'POST') {
    body = new FormData()
    for (const [key, value] of Object.entries(form.fields)) body.append(key, value)
    body.append('file', blob, file.name)
  }
  const init = { method, body, headers: method === 'PUT' ? { 'content-type': file.contentType, ...form.headers } : form.headers, signal }
  const posted = endpoint.upload ? await endpoint.upload(form.url, init, onProgress)
    : await (endpoint.fetch ?? egress.fetch)(form.url, init)
  if (posted.status !== 200 && posted.status !== 204 && !(allowExisting && posted.status === 409)) {
    throw new AttachmentsError('upload', posted.status, 'failed', `storing ${file.name} failed: HTTP ${posted.status}`)
  }
}

/** The SHA-256 (hex) a send declares for its file, read in chunks. */
export async function attachmentSha256(bytes: Uint8Array | Blob): Promise<string> {
  const hash = sha256Hash.create()
  if (bytes instanceof Uint8Array) hash.update(bytes)
  else {
    const reader = bytes.stream().getReader()
    for (;;) { const chunk = await reader.read(); if (chunk.done) break; hash.update(chunk.value) }
  }
  return Array.from(hash.digest(), byte => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * Every send of a new file, a person's or an agent's (owner 11-15): the file's index (sha256, size) and its upload plan,
 * for the message's commit. The message is complete with them; its bytes follow it (`finishDeclaredAttachment`).
 */
export type DeclaredAttachment = { staging_key: string; sha256: string; size_bytes: number; plan?: AttachmentUploadPlan }
export async function declareAttachment(endpoint: AttachmentsEndpoint, file: { bytes: Uint8Array | Blob; contentType: string },
  scope: { chat_id: string | null; as: string; request_id?: string }, signal?: AbortSignal): Promise<DeclaredAttachment> {
  const size = file.bytes instanceof Uint8Array ? file.bytes.byteLength : file.bytes.size
  const [sha256, plan] = await Promise.all([attachmentSha256(file.bytes), planAttachmentUpload(endpoint, { size, contentType: file.contentType }, scope, signal)])
  return { staging_key: plan.staging_key, sha256, size_bytes: size, plan }
}

/** How a sender follows its declared bytes up (all optional: an agent just waits for them). */
export type DeclaredUploadHooks = {
  keep?: FileKeep
  /** Runs each upload attempt, e.g. inside a timed stage with its own endpoint and signal; by default it just runs. */
  attempt?: (attempt: number, run: (endpoint: AttachmentsEndpoint, signal?: AbortSignal) => Promise<void>) => Promise<void>
  /** The plan an attempt uploads under, once it has one. */
  onPlan?: (plan: AttachmentUploadPlan) => void
  onProgress?: (progress: AttachmentByteProgress, attempt: number) => void
  /** Bytes can beat their message's commit: finish waits this long for the declaration (by default not at all). */
  declarationWaitMs?: number
  /** Nobody wants these bytes any more (their message was discarded): stop at the next step, finishing nothing. */
  stopped?: () => boolean
}
const UPLOAD_ATTEMPTS = 3

/**
 * After its message committed: the declared bytes go up, three attempts, each after the first under a new plan (also
 * when the first is gone, e.g. after a restart), and the server checks them against the declaration. Every sender's one
 * path: the desktop composer in the background, agents waiting for it. False when stopped before finishing.
 */
export async function finishDeclaredAttachment(endpoint: AttachmentsEndpoint, declared: Pick<DeclaredAttachment, 'staging_key' | 'size_bytes' | 'plan'>,
  file: { bytes: Uint8Array | Blob; name: string; contentType: string }, message: { id: string; chat_id: string | null; as: string }, hooks: DeclaredUploadHooks = {}): Promise<boolean> {
  let plan = declared.plan, uploadKey = plan ? declared.staging_key : null
  for (let attempt = 1; ; attempt++) {
    try {
      await (hooks.attempt ?? ((_, run) => run(endpoint)))(attempt, async (attemptEndpoint, signal) => {
        if (!plan) { const fresh = await planAttachmentUpload(attemptEndpoint, { size: declared.size_bytes, contentType: file.contentType }, { chat_id: message.chat_id, as: message.as }, signal); plan = fresh; uploadKey = fresh.staging_key }
        hooks.onPlan?.(plan)
        await uploadAttachmentPlan(attemptEndpoint, plan, { ...file, name: file.name || 'file' }, attempt > 1, progress => hooks.onProgress?.(progress, attempt), signal)
      })
      break
    } catch (error) {
      if (attempt >= UPLOAD_ATTEMPTS || hooks.stopped?.()) throw error
      // A multipart plan that is still alive is tried again as it is: the parts already stored are not sent again. One
      // whose permit lapsed, whose parts did not make the file, or whose upload is gone gets a new plan, like a form's.
      const lives = !!plan?.parts && !(error instanceof AttachmentsError && (error.code === 'expired' || error.code === 'upload_changed'
        || error.route === 'upload-parts' && error.code === 'upload_incomplete'))
      if (!lives) { plan = undefined; uploadKey = null } // a new plan: the old one may have expired or its object be half written
      await new Promise(resolve => setTimeout(resolve, attempt * 1000))
    }
  }
  const until = Date.now() + (hooks.declarationWaitMs ?? 0)
  for (let wait = 500; ; wait = Math.min(wait * 2, 8000)) {
    if (hooks.stopped?.()) return false
    try {
      await finishAttachment(endpoint, { staging_key: declared.staging_key, ...(uploadKey !== declared.staging_key ? { upload_key: uploadKey! } : {}),
        file_name: file.name, content_type: file.contentType, message_id: message.id, ...(hooks.keep ? { keep: hooks.keep } : {}) })
      return true
    } catch (error) {
      if (!(error instanceof AttachmentsError && error.code === 'upload_not_found') || Date.now() + wait > until) throw error
      await new Promise(resolve => setTimeout(resolve, wait))
    }
  }
}

export interface CommitArgs {
  staging_key: string
  /** The bytes this message declares (their SHA-256, hex, and size): it is sent now and they follow (`finishAttachment`). */
  sha256?: string
  size_bytes?: number
  /** A declared image's size, so readers draw its place at that size while its bytes come. */
  width?: number
  height?: number
  message_id: string
  chat_id: string
  sender_user_id: string
  file_name: string
  content_type?: string
  to_user_ids?: string[]
  reply_to_message_id?: string | null
  thread_root_id?: string | null
  is_thread_root?: boolean
  is_whisper?: boolean
  via_app?: string | null
  /** 图配文字:服务端接在信封后面(首尾空白去掉;空的就没有)。 */
  caption?: string
  /** The upload is this folder file's next version, from expected_version (a newer one stored since ⇒ refused, version_conflict). */
  item_id?: string
  expected_version?: number
  /** How long this copy stays (temporary | permanent); not given, the chat's rule. Needs a backend with file_storage_mark_as. */
  keep?: FileKeep
  /** #2581 Files sent at once: one id for the send and how many files it holds (2–10). Not given, a file sent on its own. */
  send_group_id?: string
  send_group_size?: number
}

/** Sends the upload as an attachment message: the message row as `messages_view` has it. */
export async function commitAttachment(endpoint: AttachmentsEndpoint, args: CommitArgs): Promise<Record<string, unknown>> {
  const answer = await call(endpoint, 'commit', { ...args }) as { message: Record<string, unknown> | null }
  if (!answer.message) throw new AttachmentsError('commit', 500, 'failed', `no message came back for ${args.message_id}`)
  return answer.message
}

/**
 * A declared attachment's bytes are up: under its own staging key, or `upload_key` when they went up again under a new
 * plan (a resumed send). The server hashes them against the declaration; other bytes are refused (upload_mismatch).
 */
export async function finishAttachment(endpoint: AttachmentsEndpoint, args: { staging_key: string; upload_key?: string; file_name: string; content_type: string; message_id: string; keep?: FileKeep }, signal?: AbortSignal): Promise<void> {
  await call(endpoint, 'finish', { ...args }, signal)
}

/** A declared attachment whose bytes have not reached the server, as its uploader's account lists them. */
export type PendingAttachmentUpload = { staging_key: string; message_id: string; chat_id: string; as: string; sha256: string; size_bytes: number; content_type: string; file_name: string | null }

/** The caller's declared attachments still waiting for their bytes: a restarted sender resumes those it still holds. */
export async function pendingAttachmentUploads(endpoint: AttachmentsEndpoint): Promise<PendingAttachmentUpload[]> {
  return ((await call(endpoint, 'pending', {})) as { uploads: PendingAttachmentUpload[] }).uploads
}

export interface OwnerSendArgs {
  staging_key: string
  friend_user_id: string
  agent_user_id: string
  request_id: string
  file_name: string
  content_type?: string
  caption?: string
}

/** An agent sends a file to its owner's friend as the owner (message_send_as_owner with file_path): the send, as the server answers it. */
export async function sendFileAsOwner(endpoint: AttachmentsEndpoint, args: OwnerSendArgs): Promise<{ chat_id: string; message_id: string; sender_user_id: string; sent_by_agent: boolean }> {
  const answer = await call(endpoint, 'commit', { ...args }) as { message: { chat_id: string; message_id: string; sender_user_id: string; sent_by_agent: boolean } | null }
  if (!answer.message) throw new AttachmentsError('commit', 500, 'failed', `no send came back for ${args.request_id}`)
  return answer.message
}

export type PlaceArgs =
  | { staging_key: string; chat_id: string; file_name: string; folder?: string | null; as_user_id?: string | null; source_message_ids?: string[]; content_type?: string; keep?: FileKeep }
  | { staging_key: string; item_id: string; expected_version: number; as_user_id?: string | null; content_type?: string; keep?: FileKeep }

/** Puts the upload in a chat's folder — a new file, or (item_id) a new version of one: the item row, as the *_as functions answer. */
export async function placeAttachment(endpoint: AttachmentsEndpoint, args: PlaceArgs): Promise<Record<string, unknown>> {
  const answer = await call(endpoint, 'place', { ...args }) as { item: Record<string, unknown> | null }
  if (!answer.item) throw new AttachmentsError('place', 500, 'failed', 'no item came back')
  return answer.item
}

export interface ForwardArgs {
  source_message_id: string
  message_id: string
  chat_id: string
  sender_user_id: string
  to_user_ids?: string[]
  thread_root_id?: string | null
  is_thread_root?: boolean
  is_whisper?: boolean
  /** #2581 Files forwarded together land as one send: the same group on each copy, and how many copies it holds. */
  send_group_id?: string
  send_group_size?: number
}

/** Forwards an attachment message of the new kind (its own item in the target's folder, the same bytes): the new message row. */
export async function forwardAttachment(endpoint: AttachmentsEndpoint, args: ForwardArgs): Promise<Record<string, unknown>> {
  const answer = await call(endpoint, 'forward', { ...args }) as { message: Record<string, unknown> | null }
  if (!answer.message) throw new AttachmentsError('forward', 500, 'failed', `no message came back for ${args.source_message_id}`)
  return answer.message
}

export interface ShareArgs {
  item_id: string
  /** A stored file's version (none = its current one); a text document is always sent as its text is now. */
  version?: number | null
  message_id: string
  chat_id: string
  sender_user_id: string
  to_user_ids?: string[]
  reply_to_message_id?: string | null
  thread_root_id?: string | null
  /** The message's text under the file card (首尾空白去掉;空的就没有). */
  caption?: string
}

/** Sends a file of a chat's folder by reference — no bytes from here; the one way a folder file becomes a file card: the new message row. */
export async function shareAttachment(endpoint: AttachmentsEndpoint, args: ShareArgs): Promise<Record<string, unknown>> {
  const answer = await call(endpoint, 'share', { ...args }) as { message: Record<string, unknown> | null }
  if (!answer.message) throw new AttachmentsError('share', 500, 'failed', `no message came back for ${args.item_id}`)
  return answer.message
}

/** Shared authenticated transport for additional private attachment scopes. */
export { call as attachmentRequest }
