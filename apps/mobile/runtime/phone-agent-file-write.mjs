import { constants } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { copyFile, lstat, mkdir, open, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { mimeTypeFromName } from '../../../packages/core/src/shared/imageMime.mjs'
import { stableId, uuid } from './phone-agent-store.mjs'

export const PHONE_TEXT_OUTPUT_MAX_BYTES = 1024 * 1024
const fail = (code, message) => Object.assign(new Error(message), { code })
const uniqueProofs = (...sources) => [...new Map(sources.flatMap((source) => source ?? []).map((proof) => [JSON.stringify(proof), structuredClone(proof)])).values()]
const invalidFilenameCharacter = (character) => {
  const code = character.charCodeAt(0)
  return character === '/' || character === '\\' || character === ':' || code <= 31 || code >= 127 && code <= 159 || code >= 0x202a && code <= 0x202e || code >= 0x2066 && code <= 0x2069
}
const invalidCallIdCharacter = (character) => { const code = character.charCodeAt(0); return code <= 31 || code === 127 }

function contentOf(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some((name) => name !== 'file_name' && name !== 'text')) throw fail('invalid_args', 'Only file_name and text are accepted; a path or overwrite mode cannot be specified')
  const name = args?.file_name
  if (typeof name !== 'string' || !name || name !== name.trim() || Buffer.byteLength(name, 'utf8') > 120 || name.startsWith('.') || Array.from(name).some(invalidFilenameCharacter) || !name.isWellFormed()) throw fail('invalid_args', 'file_name must be a single plain file name of at most 120 bytes, without a path, a hidden file name or control characters')
  // Its name is its format, read from the one table every door uses (a chat's folder decides a document's type by it).
  const mime = mimeTypeFromName(name)
  if (mime !== 'application/json' && !mime?.startsWith('text/')) throw fail('unsupported', 'Only UTF-8 text reports named with their type can be generated, such as .md, .txt, .csv, .json, .html; PDF, Office and other binary formats are not generated')
  if (typeof args.text !== 'string' || !args.text.isWellFormed() || args.text.includes('\0')) throw fail('invalid_args', 'text must be valid UTF-8 text without null bytes')
  if (Buffer.byteLength(args.text, 'utf8') > PHONE_TEXT_OUTPUT_MAX_BYTES) throw fail('too_large', 'A single phone text output is at most 1 MiB; shorten the report and save again')
  const bytes = Buffer.from(args.text, 'utf8')
  return { name, mime, bytes, sha256: createHash('sha256').update(bytes).digest('hex') }
}

async function outputDirectory(store, agent) {
  const base = await realpath(store.directory)
  const directories = [base]
  for (const part of ['outputs', uuid(agent.agentUserId, 'agentUserId'), uuid(agent.sessionId, 'sessionId')]) {
    const next = join(directories.at(-1), part)
    try { await mkdir(next, { mode: 0o700 }) } catch (error) { if (error.code !== 'EEXIST') throw error }
    directories.push(next)
    const info = await lstat(next)
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(next) !== next) throw fail('not_granted', 'The task output directory changed; cannot write elsewhere through a link')
  }
  const directory = directories.at(-1)
  const expected = await lstat(directory)
  const handle = await open(directory, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0))
  const check = async () => {
    for (const path of directories) {
      const info = await lstat(path)
      if (!info.isDirectory() || info.isSymbolicLink() || await realpath(path) !== path) throw fail('not_granted', 'The task output directory changed while saving; file not delivered')
    }
    const pinned = await handle.stat()
    const current = await lstat(directory)
    if (pinned.dev !== expected.dev || pinned.ino !== expected.ino || current.dev !== pinned.dev || current.ino !== pinned.ino) throw fail('not_granted', 'The task output directory was replaced while saving; file not delivered')
  }
  try { await check() } catch (error) { await handle.close(); throw error }
  // Android's app-private filesystem is POSIX. Anchor writes to the opened directory so an
  // ancestor renamed during IO cannot redirect a leaf into an unrelated directory.
  const ioDirectory = process.platform === 'android' || process.platform === 'linux' ? `/proc/self/fd/${handle.fd}` : directory
  return { directory, ioDirectory, check, close: () => handle.close() }
}

async function verifyFile(path, expected, sync = false) {
  const file = await open(path, (sync ? constants.O_RDWR : constants.O_RDONLY) | (constants.O_NOFOLLOW ?? 0))
  try {
    const before = await file.stat()
    if (!before.isFile() || before.size !== expected.bytes.length || before.nlink !== 1) throw fail('file_changed', 'The existing output is incomplete or changed; the original file is kept and cannot be overwritten or reused')
    const bytes = Buffer.alloc(expected.bytes.length + 1)
    let size = 0
    while (size < bytes.length) {
      const read = await file.read(bytes, size, bytes.length - size, size)
      if (!read.bytesRead) break
      size += read.bytesRead
    }
    const after = await file.stat()
    if (size !== expected.bytes.length || after.size !== before.size || after.dev !== before.dev || after.ino !== before.ino || createHash('sha256').update(bytes.subarray(0, size)).digest('hex') !== expected.sha256) throw fail('file_changed', 'The output of this same tool call changed; the original file is kept and the file is not delivered')
    if (sync) await file.sync()
  } finally { await file.close() }
}

/** Text-only report generation. There is no caller-supplied path, append mode or overwrite mode. */
export function phoneTextWriteTool({ agent, job, store, authorize, registerArtifact }) {
  const inflight = new Map()
  const write = async (callId, input, id, fingerprint, signal) => {
    const ownerId = uuid(store.state.ownerId, 'ownerId')
    if (agent.ownerId && agent.ownerId !== ownerId || job.agentUserId && job.agentUserId !== agent.agentUserId) throw fail('not_granted', 'This output does not belong to the current owner and task')
    store.state.outputWrites ??= {}
    let entry = store.state.outputWrites[id]
    const validateEntry = () => { if (entry && (entry.ownerId !== ownerId || entry.agentUserId !== agent.agentUserId || entry.sessionId !== agent.sessionId || entry.jobId !== job.id || entry.fingerprint !== fingerprint)) throw fail('invalid_args', 'The same tool call cannot change the name or content; use a new tool call to create another output') }
    validateEntry()
    const proof = () => ({ groups: [...new Set([...(entry?.groups ?? []), ...(job.usedGroups ?? [])])], permissionRequirements: uniqueProofs(entry?.permissionRequirements, job.permissionRequirements) })
    const check = async (bound = proof()) => { signal?.throwIfAborted(); await authorize(bound.groups, { sessionId: agent.sessionId, permissionRequirements: bound.permissionRequirements }); signal?.throwIfAborted(); return bound }
    await check()
    // Another instance can claim the same journal key while authorization is in flight.
    entry = store.state.outputWrites[id]
    validateEntry()
    // Claim the immutable request before any file is created. A failed save never starts IO.
    entry ??= store.state.outputWrites[id] = { id, ownerId, agentUserId: agent.agentUserId, sessionId: agent.sessionId, jobId: job.id, callId, fingerprint, name: input.name, sha256: input.sha256, size: input.bytes.length, status: 'preparing', ...proof() }
    await store.save()
    const output = await outputDirectory(store, agent)
    const name = `${id}-${input.name}`
    const path = join(output.directory, name)
    const ioPath = join(output.ioDirectory, name)
    const temporaryName = `.${randomUUID()}.incomplete`
    const temporary = join(output.ioDirectory, temporaryName)
    const canonicalTemporary = join(output.directory, temporaryName)
    let file
    try {
      await output.check(); await check()
      file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600)
      await file.writeFile(input.bytes); await file.sync(); await file.close(); file = null
      await verifyFile(temporary, input)
      signal?.throwIfAborted(); await check(); await output.check()
      // Android may forbid hardlinks even inside app-private storage. Exclusive copy
      // never overwrites a final path, but copying is not filesystem-atomic: only a
      // fully verified file can be registered/delivered. Unknown partials stay private.
      try { await copyFile(canonicalTemporary, path, constants.COPYFILE_EXCL) } catch (error) { if (error.code !== 'EEXIST') throw error }
      await output.check()
      await verifyFile(ioPath, input, true); await output.check()
      await rm(temporary)
      const bound = await check()
      entry.groups = bound.groups; entry.permissionRequirements = bound.permissionRequirements; entry.file_path = path
      const registered = await registerArtifact({ store, agent, groups: bound.groups, file: { file_path: path, name: input.name, mime_type: input.mime, size: input.bytes.length, sha256: input.sha256, permissionRequirements: structuredClone(bound.permissionRequirements) } })
      if (registered.file_path !== path) {
        delete store.state.artifacts[registered.artifact_id]
        await store.save()
        throw fail('file_changed', 'The task output path changed while registering; file not delivered')
      }
      entry.status = 'ready'; entry.artifactId = registered.artifact_id
      await store.save(); await output.check(); await verifyFile(path, input); await output.check(); await check(bound)
      const data = { ok: true, ...registered }
      return { content: [{ type: 'text', text: JSON.stringify(data) }], details: data }
    } finally {
      await file?.close().catch(() => undefined)
      await rm(temporary, { force: true }).catch(() => undefined)
      await output.close()
    }
  }
  return { name: 'phone_file_write', label: 'Create task text file', description: 'Save text from this task as a private output on this device; then view it with phone_file_list/read, or send it with message_send_file to a Gugu chat you may post in. Provide only file_name (a single file name, no path) and text; UTF-8 text such as Markdown, plain text, CSV, JSON or HTML is supported, at most 1 MiB per file. PDF, Office and binary files cannot be created. Existing different content is never overwritten; retrying the same tool call returns the same output. Phone data permissions stay attached to the output; after they are revoked it cannot be read or sent.',
    parameters: { type: 'object', additionalProperties: false, required: ['file_name', 'text'], properties: { file_name: { type: 'string', description: 'For example report.md; no directory, path or hidden file name' }, text: { type: 'string', description: 'The complete UTF-8 text to save, at most 1 MiB' } } },
    execute: async (callId, args, signal) => {
      if (typeof callId !== 'string' || !callId || callId.length > 512 || Array.from(callId).some(invalidCallIdCharacter)) throw fail('invalid_args', 'Invalid tool call id; the output cannot be registered safely')
      const input = contentOf(args)
      const id = stableId('phone-text-output', uuid(store.state.ownerId), uuid(agent.agentUserId), uuid(agent.sessionId), uuid(job.id, 'jobId'), callId)
      const fingerprint = stableId(input.name, input.mime, input.sha256)
      const existing = inflight.get(id)
      if (existing) { if (existing.fingerprint !== fingerprint) throw fail('invalid_args', 'The same tool call cannot change the name or content'); return existing.promise }
      const promise = write(callId, input, id, fingerprint, signal)
      inflight.set(id, { fingerprint, promise })
      try { return await promise } finally { if (inflight.get(id)?.promise === promise) inflight.delete(id) }
    },
  }
}
