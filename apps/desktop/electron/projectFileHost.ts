import { openAsBlob } from 'node:fs'
import { createHash } from 'node:crypto'
import { copyVerifiedFile } from '@gugu/core/shared/fileCipher'
import { fileRefKey, requireFileRange, requireFileRevision, type FileBytes, type FileContext, type FileRef, type FileRevision } from '@gugu/core/shared/fileResolver'
import { inWorkspace, readWorkspaceChunk, streamFileRange } from './session/main/core/files/workspace-transfer'
import { readProjectFile, type ProjectFileVersionLookup } from './sessionpage/sessionpage-project-groups'
import { createFileSink } from './fileSnapshot'
import { nextPartBytes, SMALLEST_PART_BYTES } from '@shared/extensions/working-copy-upload'

export const PROJECT_FILE_READ = 'file.read'
/** Remote protocol 19 and later (`FILE_STREAM_PROTOCOL`): a held version read as one stream of raw bytes. */
export const PROJECT_FILE_STREAM = 'file.stream'
const LINE_BUDGET_MS = 2_500
type ReadRequest = { ref: FileRef; offset: number; length: number; etag?: string }
export type ProjectFileChunk = { revision: FileRevision; offset: number; etag: string; data: string }
export type ProjectFileReader = (request: ReadRequest) => Promise<ProjectFileChunk>

/** The host chooses the path from the version record (readProjectFile). No reader path or write operation is accepted. */
type HeldFileDeps = { identity(): Promise<{ accountId: string; deviceId: string }>; root(projectId: string): Promise<string | null>; env?: NodeJS.ProcessEnv; later: ProjectFileVersionLookup }
/** Only the device's own account reads its held versions; the path is the version record's, inside the project's root. */
async function heldVersion(deps: HeldFileDeps, ref: FileRef, callerId: string) {
  fileRefKey(ref)
  const identity = await deps.identity()
  if (identity.accountId !== callerId) throw new Error('File reader is not the device owner')
  const revision = await readProjectFile(ref, identity.accountId, identity.deviceId, deps.env, deps.later)
  if (!revision) throw new Error('Local file revision is unavailable')
  const root = await deps.root(revision.host_project_id!)
  if (!root) throw new Error('Project root is unavailable')
  const stillBound = async () => JSON.stringify(await deps.identity()) === JSON.stringify(identity) && !!await readProjectFile(ref, identity.accountId, identity.deviceId, deps.env, deps.later)
  return { revision, root, stillBound }
}

export function createProjectFileReader(deps: HeldFileDeps) {
  return async (request: ReadRequest, callerId: string): Promise<ProjectFileChunk> => {
    if (!request || Object.keys(request).some(key => !['ref', 'offset', 'length', 'etag'].includes(key))) throw new Error('Invalid file read request')
    const { revision, root, stillBound } = await heldVersion(deps, request.ref, callerId)
    requireFileRange(revision.size_bytes, request.offset, request.length)
    const chunk = await readWorkspaceChunk(root, { path: revision.relative_path!, offset: request.offset, length: request.length })
    if (chunk.size !== revision.size_bytes || request.etag !== undefined && request.etag !== chunk.etag) throw new Error('Local file changed during read')
    if (!await stillBound()) throw new Error('File binding changed during read')
    // Absolute host paths stay here. The current etag anchors this read, not the publication mtime.
    return { revision, offset: chunk.offset, etag: chunk.etag, data: chunk.data }
  }
}

type StreamRequest = { ref: FileRef; offset: number; etag?: string; stream: string }

/**
 * `file.stream`: a held version's bytes from `offset` to its end, raw, as fast as the line takes them (a device link's `D`
 * frames, `DeviceLinkStream`). The version on disk is said before the bytes (`head`); one that is not the held size, or not
 * the `etag` a resuming reader names, or that changes while it streams, is refused, never sent mixed. The reader verifies
 * the whole file's sha as it does for parts.
 */
export function createProjectFileStreamer(deps: HeldFileDeps) {
  return async (payload: unknown, context: { userId: string; head(version: { size: number; etag: string }): void; write(offset: number, bytes: Uint8Array): Promise<void>; signal: AbortSignal }) => {
    const request = payload as StreamRequest
    if (!request || Object.keys(request).some(key => !['ref', 'offset', 'etag', 'stream'].includes(key)) || (request.etag !== undefined && typeof request.etag !== 'string')) throw new Error('Invalid file stream request')
    const { revision, root, stillBound } = await heldVersion(deps, request.ref, context.userId)
    return streamFileRange(await inWorkspace(root, revision.relative_path!, true), { size: revision.size_bytes, etag: request.etag }, request.offset, context, stillBound)
  }
}

/** Local and SSH both feed the same full SHA verification before any bytes are exposed. */
/**
 * A held file's bytes through its host's reader, in the parts a working copy is read in (`nextPartBytes`): over another
 * machine's link one call holds the line, so a part stays about a second long and says how far the file has come.
 */
export async function openProjectFileSource(revision: FileRevision, read: ProjectFileReader, progress?: FileContext['progress']): Promise<FileBytes> {
  requireFileRevision(revision)
  const ref = { item_id: revision.item_id!, version: revision.version! }
  const first = await read({ ref, offset: 0, length: 0 })
  const identity = (value: FileRevision) => JSON.stringify([value.item_id, value.version, value.chat_id, value.host_account_id, value.host_device_id, value.host_project_id, value.relative_path, value.sha256, value.size_bytes])
  const check = (chunk: ProjectFileChunk, offset: number, length: number) => {
    requireFileRevision(chunk.revision)
    const bytes = Buffer.from(chunk.data, 'base64')
    if (!first.etag || chunk.etag !== first.etag || chunk.offset !== offset || identity(chunk.revision) !== identity(revision) ||
      bytes.length !== length || bytes.toString('base64') !== chunk.data) throw new Error('Invalid project file chunk')
    return new Uint8Array(bytes)
  }
  check(first, 0, 0)
  const size = revision.size_bytes
  // @@@read-ahead - the parts run ahead of the caller, who reads the file front to back: the next part is asked for while
  // one is on the line, so no part (and no next read) waits a round trip behind the last. The time from the later of a
  // part's asking and the last arrival is its own time on the line, which sizes the next part and gives the line's rate.
  // A second part goes out only while both stay within LINE_BUDGET_MS of that rate: whatever else the link carries waits
  // behind them, and a session's frames are given four seconds. Every part is checked against the anchored etag, so parts
  // asked ahead are of the same version as the rest, and the whole file's SHA is verified where it is consumed.
  let part = SMALLEST_PART_BYTES, perMs = 0, last = 0, asked = 0, heldAt = 0, held = new Uint8Array(0)
  let flight: { at: number; take: number; full: boolean; asked: number; reply: Promise<ProjectFileChunk> }[] = []
  const ask = () => {
    const take = Math.min(part, size - asked), reply = read({ ref, offset: asked, length: take, etag: first.etag })
    reply.catch(() => {}) // a part's failure is thrown where it is awaited, or never if the caller has moved elsewhere
    flight.push({ at: asked, take, full: take === part, asked: Date.now(), reply }); asked += take
  }
  const askAhead = () => {
    while (asked < size && (flight.length === 0 || flight.length === 1 && flight[0]!.take + Math.min(part, size - asked) <= perMs * LINE_BUDGET_MS)) ask()
  }
  return { size, dispose: async () => {}, async read(offset, length) {
    requireFileRange(size, offset, length)
    if (offset !== heldAt) { flight = []; held = new Uint8Array(0); heldAt = asked = offset }
    while (held.length < length) {
      askAhead()
      const next = flight.shift()!
      let data: Uint8Array<ArrayBuffer>
      try { data = check(await next.reply, next.at, next.take) } catch (error) { heldAt = -1; throw error } // read again from scratch
      const now = Date.now(), took = Math.max(1, now - Math.max(last, next.asked))
      if (next.full) part = nextPartBytes(next.take, took)
      perMs = next.take / took
      last = now
      held = held.length ? Buffer.concat([held, data]) : data
      progress?.(next.at + next.take, size)
    }
    const bytes = new Uint8Array(held.subarray(0, length))
    held = held.subarray(length); heldAt += length
    askAhead()
    return bytes
  } }
}

/** A held version's bytes (parts or a stream) into a private snapshot, verified against its sha before anyone reads it. */
export async function snapshotProjectFile(revision: FileRevision, source: FileBytes, tempRoot: string, signal?: AbortSignal): Promise<FileBytes> {
  try { return await copyVerifiedFile(revision, source, await createFileSink(tempRoot, revision.size_bytes), signal) }
  finally { await source.dispose() }
}

/**
 * A version this machine holds, read where it is: checked once against its sha (that pass is its progress), then read in
 * place. A file-backed Blob refuses to read once its file changes, so no later byte can come from another version.
 */
export async function heldFileBlob(revision: FileRevision, root: string, progress?: FileContext['progress']): Promise<Blob> {
  const { path } = await readWorkspaceChunk(root, { path: revision.relative_path!, offset: 0, length: 0 })
  const blob = await openAsBlob(path)
  if (blob.size !== revision.size_bytes) throw new Error('Local file changed')
  const hash = createHash('sha256')
  let done = 0
  for await (const chunk of blob.stream()) { hash.update(chunk); done += chunk.length; progress?.(done, blob.size) }
  if (hash.digest('hex') !== revision.sha256) throw new Error('Local file changed')
  return blob
}
async function openHeldFile(revision: FileRevision, root: string, progress?: FileContext['progress']): Promise<FileBytes> {
  const blob = await heldFileBlob(revision, root, progress)
  return { size: blob.size, read: async (offset, length) => { requireFileRange(blob.size, offset, length); return new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer()) }, dispose: async () => {} }
}

/** The person's own copy, before any metadata lookup; and, once an actor's metadata lookup has authorized it, where its bytes are read (fileResolver `open`). */
export function localProjectFileProvider(deps: {
  identity(): Promise<{ accountId: string; deviceId: string }>
  read: ReturnType<typeof createProjectFileReader>; root(projectId: string): Promise<string | null>; env?: NodeJS.ProcessEnv; later: ProjectFileVersionLookup
}) {
  return async (context: FileContext) => {
    const identity = await deps.identity()
    if (context.actor.actorId !== identity.accountId || context.actor.accountId !== identity.accountId) return null
    const revision = await readProjectFile(context.ref, identity.accountId, identity.deviceId, deps.env, deps.later)
    if (!revision) return null
    return { revision, async open() {
      if (context.download) return openProjectFileSource(revision, request => deps.read(request, context.actor.actorId))
      const root = await deps.root(revision.host_project_id!)
      if (!root) throw new Error('Project root is unavailable')
      return openHeldFile(revision, root, context.progress)
    } }
  }
}
