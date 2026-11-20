import { createReadStream } from 'node:fs'
import { chmod, mkdir, rename, stat } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { createFileSink } from './fileSnapshot'
import type { AttachmentDeclareRequest, createAttachmentUploadHost } from './attachmentUploadHost'
import type { SelectedProjectFile, ProjectFileMessage } from './projectFilePublication'
import { sanitizeRemoteFileName } from './remoteFileOpen'
import { FILE_CHUNK_BYTES, fileRefKey, FileReadRevokedError, MissingFileObjectError, requireFileRange, type FileActor, type FileHandle, type FileMetadata, type FileProviders, type FileRef, type FileRevision, type FileStageCommand, type ResolvedPreview } from '@gugu/core/shared/fileResolver'
import { FileReadError, type FileReadOptions, type FileReadResult, type FileReads, type FileReadState } from '@gugu/core/shared/fileReads'

type ReadIdentity = { id: string; ref: FileRef; actor: FileActor }
export type NativeFileReadCommand =
  | { op: 'nudge' }
  | ReadIdentity & (
    | { op: 'request'; purpose: FileReadOptions['purpose']; admit?: FileMetadata }
    | { op: 'resolve'; purpose?: 'file' | 'preview'; localOnly?: true; showFirst?: true }
    | { op: 'metadata' }
    | { op: 'cancel' | 'dispose' | 'ack' | 'preview' }
    | { op: 'read'; offset: number; length: number }
  )

export type NativeFileReadResult = Omit<FileReadResult, 'file'> & { revision: FileRevision }
type ReadReplies = {
  request: NativeFileReadResult; resolve: FileMetadata | null; metadata: FileMetadata
  read: Uint8Array; preview: { url: string; expiresAt: number } | { bytes: Uint8Array; type: string } | { size: number; type: string }
  nudge: void; ack: void; dispose: void; cancel: void
}
export interface NativeFileReadIpc {
  fileRead<C extends NativeFileReadCommand>(command: C): Promise<ReadReplies[C['op']]>
  onFileReadState(listener: (event: { id: string; state: FileReadState }) => void): () => void
}

type ReadHandle = FileHandle | Extract<ResolvedPreview, { status: 'ready' }>
type Reader = {
  scope: number; epoch: number; owner: string; actor: string; ref: string
  controller: AbortController; file?: ReadHandle; preview?: Blob; unsubscribe?: () => void
}

/** Opaque capabilities stay within the issuing renderer and account. Bytes use the existing invoke bus and FileSink. */
export function createNativeFileHost(deps: {
  attachments?: ReturnType<typeof createAttachmentUploadHost>
  root: string; owner(): Promise<string | null>; alive(scope: number): boolean
  reads: FileReads; metadata: FileProviders['metadata']; openPath(path: string): Promise<string>
  published(directory: string): void; maxBytes?: number
  publish?(chatId: string, file: SelectedProjectFile, owner: string, message?: ProjectFileMessage, task?: { itemId?: string }): Promise<unknown>
  /** A task attachment's own copy for the agent (`writeTaskCopy`): its path. */
  taskCopy?(name: string, bytes: Uint8Array, mimeType?: string): Promise<{ path: string; name: string; size: number; mimeType?: string }>
  publication?(chatId: string, owner: string): Promise<boolean>
}) {
  type Entry = { scope: number; epoch: number; owner: string; name?: string; size?: number; sha?: string;
    sink?: Awaited<ReturnType<typeof createFileSink>>; hash?: ReturnType<typeof createHash>; written?: number; path?: string; busy?: boolean }
  const entries = new Map<string, Entry>()
  const readers = new Map<string, Reader>()
  let lastOwner: string | null = null
  const epochs = new Map<number, number>()
  const epochOf = (scope: number) => { const value = epochs.get(scope) ?? 0; epochs.set(scope, value); return value }
  const check = async (scope: number, owner: string, epoch: number) => {
    const current = await deps.owner()
    if (!deps.alive(scope) || epoch !== epochOf(scope) || owner !== current) throw new Error('File reader account or window changed')
  }
  const release = async (key: string, row: Reader) => {
    if (readers.get(key) === row) readers.delete(key)
    row.controller.abort()
    row.unsubscribe?.()
    const file = row.file
    row.file = undefined
    await file?.dispose()
  }
  const drop = async (scope?: number) => {
    for (const id of scope === undefined ? epochs.keys() : [scope]) epochs.set(id, epochOf(id) + 1)
    await Promise.all([
      ...[...readers].filter(([, row]) => scope === undefined || row.scope === scope).map(([key, row]) => release(key, row)),
      ...[...entries].filter(([, entry]) => scope === undefined || entry.scope === scope).map(async ([id, entry]) => {
        entries.delete(id); await entry.sink?.abort()
      }),
    ])
  }
  const entryFor = async (scope: number, id: string) => {
    const entry = entries.get(id)
    if (!entry || entry.scope !== scope) throw new Error('File handle is unavailable')
    await check(scope, entry.owner, entry.epoch); return entry
  }
  return { drop,
    async attachment(scope: number, request: ({ op: 'declare' } & AttachmentDeclareRequest) | { op: 'drop' | 'retry'; messageId: string } | { op: 'resume' }) {
      const epoch = epochOf(scope), owner = await deps.owner()
      if (!owner || !deps.attachments) throw new Error('Attachment uploader is unavailable')
      await check(scope, owner, epoch)
      const result = request.op === 'declare' ? (await deps.attachments.declare(request)).declared
        : request.op === 'resume' ? await deps.attachments.resume() : await deps.attachments[request.op](request.messageId)
      await check(scope, owner, epoch)
      return result
    },
    /** `task`: a task's input attachment, kept on this device (`ProjectFilePublishOptions.task`). */
    async publish(scope: number, request: { chatId: string; file?: SelectedProjectFile; message?: ProjectFileMessage; task?: boolean; itemId?: string }) {
      const epoch = epochOf(scope), owner = await deps.owner(); if (!owner || !deps.publish || !request.file && !deps.publication) throw new Error('File publisher is unavailable')
      await check(scope, owner, epoch); const row = request.file ? await deps.publish(request.chatId, request.file, owner, request.message, request.task === true ? { itemId: request.itemId } : undefined) : await deps.publication!(request.chatId, owner); await check(scope, owner, epoch); return row
    },
    async taskCopy(scope: number, request: { name: string; data: ArrayBuffer; mimeType?: string }) {
      const epoch = epochOf(scope), owner = await deps.owner(); if (!owner || !deps.taskCopy) throw new Error('File publisher is unavailable')
      await check(scope, owner, epoch); return deps.taskCopy(request.name, new Uint8Array(request.data), request.mimeType)
    },
    async ownerChanged(owner: string | null) { if (owner !== lastOwner) { lastOwner = owner; await drop() } },
    async read(scope: number, command: NativeFileReadCommand, report?: (event: { id: string; state: FileReadState }) => void) {
      if (command.op === 'nudge') return deps.reads.nudge()
      const { actor, ref, id } = command
      if (typeof id !== 'string' || !id || !actor.accountId || !actor.actorId) throw new Error('Invalid file reader')
      const key = JSON.stringify([scope, id]), refKey = fileRefKey(ref)
      const existing = readers.get(key)
      if (existing && (existing.owner !== actor.accountId || existing.actor !== actor.actorId || existing.ref !== refKey)) throw new Error('File handle belongs to another reader')
      if (command.op === 'cancel' || command.op === 'dispose') {
        if (existing) await release(key, existing)
        return
      }
      if (command.op === 'resolve' || command.op === 'request' || command.op === 'metadata') {
        if (existing) throw new Error('File read id is already in use')
        // Register before the first await so a cancel or window close during account lookup also owns this waiter.
        const row: Reader = { scope, epoch: epochOf(scope), owner: actor.accountId, actor: actor.actorId, ref: refKey, controller: new AbortController() }
        const { signal } = row.controller
        readers.set(key, row)
        try {
          await check(scope, row.owner, row.epoch)
          signal.throwIfAborted()
          if (command.op === 'metadata') {
            const metadata = await deps.metadata({ ref, actor, signal })
            await check(scope, row.owner, row.epoch)
            signal.throwIfAborted()
            return metadata
          }
          if (command.op === 'request') {
            const request = deps.reads.request(ref, actor, { purpose: command.purpose, ...(command.admit ? { admit: command.admit } : {}), signal })
            row.unsubscribe = request.state$(state => { if (!signal.aborted) report?.({ id, state }) })
            const { file, ...outcome } = await request.result
            row.file = file
            await check(scope, row.owner, row.epoch)
            signal.throwIfAborted()
            return { ...outcome, revision: file.revision }
          }
          const file = command.purpose === 'preview'
            ? await deps.reads.resolve(ref, actor, { purpose: 'preview', signal })
            : command.localOnly ? await deps.reads.resolve(ref, actor, { localOnly: true, signal })
              : await deps.reads.resolve(ref, actor, { showFirst: command.showFirst, signal })
          if (file?.status === 'ready') row.file = file
          await check(scope, row.owner, row.epoch)
          signal.throwIfAborted()
          return file?.status === 'ready' ? { status: 'ready' as const, revision: file.revision } : file
        } catch (error) {
          await release(key, row)
          throw error
        } finally {
          if (!row.file && readers.get(key) === row) readers.delete(key)
        }
      }
      if (!existing?.file) throw new Error('File handle is unavailable')
      const { file, controller: { signal } } = existing
      await check(scope, existing.owner, existing.epoch)
      signal.throwIfAborted()
      let result
      if (command.op === 'read' && file.purpose === 'file') {
        requireFileRange(file.revision.size_bytes, command.offset, command.length)
        result = await file.read(command.offset, command.length)
      } else if (command.op === 'read' && existing.preview) {
        requireFileRange(existing.preview.size, command.offset, command.length)
        result = new Uint8Array(await existing.preview.slice(command.offset, command.offset + command.length).arrayBuffer())
      } else if (command.op === 'ack' && file.purpose === 'file') {
        await file.acknowledgement?.()
      } else if (command.op === 'preview' && file.purpose === 'preview') {
        const content = await file.content()
        if (content instanceof Blob && content.size > FILE_CHUNK_BYTES) {
          existing.preview = content
          result = { size: content.size, type: content.type }
        } else result = content instanceof Blob ? { bytes: new Uint8Array(await content.arrayBuffer()), type: content.type } : content
      } else throw new Error('Invalid operation for file handle')
      await check(scope, existing.owner, existing.epoch)
      signal.throwIfAborted()
      return result
    },
    async stage(scope: number, command: FileStageCommand) {
      if (command.op === 'begin') {
        const { revision } = command, epoch = epochOf(scope), owner = await deps.owner()
        if (!owner) throw new Error('File reader is not signed in')
        requireFileRange(revision.size_bytes, 0, 0)
        if (revision.size_bytes > (deps.maxBytes ?? Infinity)) throw new Error('File exceeds the byte limit')
        if (typeof revision.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(revision.sha256)) throw new Error('Invalid file commitment')
        const name = sanitizeRemoteFileName(command.name), sink = await createFileSink(deps.root, revision.size_bytes)
        try { await check(scope, owner, epoch) } catch (error) { await sink.abort(); throw error }
        const id = randomUUID(); entries.set(id, { scope, epoch, owner, name, sink, sha: revision.sha256, size: revision.size_bytes, written: 0, hash: createHash('sha256') }); return { id }
      }
      const entry = await entryFor(scope, command.id)
      if (entry.busy) throw new Error('File stage is busy')
      entry.busy = true
      try {
        if (command.op === 'abort') return
        if (!entry.sink) throw new Error('File stage is unavailable')
        if (command.op === 'chunk') {
          if (!(command.bytes instanceof Uint8Array)) throw new Error('Invalid file bytes')
          requireFileRange(entry.size!, entry.written!, command.bytes.length)
          await entry.sink.write(command.bytes); entry.hash!.update(command.bytes); entry.written! += command.bytes.length; return
        }
        if (command.op !== 'commit') throw new Error('Unknown file stage operation')
        if (entry.written !== entry.size || entry.hash!.digest('hex') !== entry.sha) throw new Error('File SHA-256 mismatch')
        await entry.sink.commit(); await check(scope, entry.owner, entry.epoch)
        const directory = join(deps.root, `open-${entry.sha}`), path = join(directory, entry.name!)
        const existing = await stat(path).catch(error => { if (error.code === 'ENOENT') return null; throw error })
        const hash = createHash('sha256')
        if (existing?.size === entry.size) for await (const bytes of createReadStream(path)) hash.update(bytes)
        if (existing?.size !== entry.size || hash.digest('hex') !== entry.sha) {
          if (existing) await chmod(path, 0o600)
          await mkdir(directory, { recursive: true, mode: 0o700 }); await rename(entry.sink.path(), path)
        }
        await entry.sink.abort(); entry.sink = undefined; entry.path = path; deps.published(directory)
      } catch (error) { entries.delete(command.id); await entry.sink?.abort(); throw error }
      finally { entry.busy = false; if (command.op === 'abort') { entries.delete(command.id); await entry.sink?.abort() } }
    },
    async open(scope: number, id: string) {
      const entry = await entryFor(scope, id)
      if (!entry.path || entry.sink) throw new Error('File stage is not committed')
      try { const error = await deps.openPath(entry.path); if (error) throw new Error(`Could not open file: ${error}`) }
      finally { entries.delete(id) } // Keep the verified cache file for repeated opens, including an OS refusal.
    },
  }
}

/** Bind lifetime to the existing WebContents; no additional connection or service is created. */
export function registerNativeFileIpc(ipc: IpcMain, host: ReturnType<typeof createNativeFileHost>, warn: (error: unknown) => void) {
  const bound = new Set<number>()
  const scope = (event: IpcMainInvokeEvent) => {
    const id = event.sender.id
    if (!bound.has(id)) {
      bound.add(id)
      const close = () => { bound.delete(id); event.sender.removeListener('destroyed', close); event.sender.removeListener('render-process-gone', close); void host.drop(id).catch(warn) }
      event.sender.once('destroyed', close); event.sender.once('render-process-gone', close)
    }
    return id
  }
  ipc.handle('files:task-copy', async (event, row: Parameters<typeof host.taskCopy>[1]) => {
    try { return await host.taskCopy(scope(event), row) } catch (error) { warn(error); throw error }
  })
  ipc.handle('files:publish', async (event, row: Parameters<typeof host.publish>[1]) => {
    try { return await host.publish(scope(event), row) } catch (error) { warn(error); throw error }
  })
  ipc.handle('attachments:declare', (event, row: AttachmentDeclareRequest) => host.attachment(scope(event), { ...row, op: 'declare' }))
  ipc.handle('attachments:drop', (event, row: { messageId: string }) => host.attachment(scope(event), { ...row, op: 'drop' }))
  ipc.handle('attachments:retry', (event, row: { messageId: string }) => host.attachment(scope(event), { ...row, op: 'retry' }))
  ipc.handle('attachments:resume', event => host.attachment(scope(event), { op: 'resume' }))
  ipc.handle('files:read', async (event, command: NativeFileReadCommand) => {
    try {
      return await host.read(scope(event), command, progress => {
        if (!event.sender.isDestroyed()) event.sender.send('files:read-state', progress)
      })
    } catch (error) {
      // Electron only transports the error message. Preserve the resolver's typed display/withdrawal decision.
      const cause = error instanceof FileReadError ? error.cause : error
      const detail = cause instanceof FileReadRevokedError ? { kind: 'revoked', reason: cause.reason }
        : cause instanceof MissingFileObjectError ? { kind: 'missing' }
          : error instanceof FileReadError ? { kind: 'failed', code: error.code } : null
      if (detail) throw new Error(`${error instanceof Error ? error.message : String(error)}\ngugu-file-error ${JSON.stringify(detail)}`)
      throw error
    }
  })
  ipc.handle('files:stage', (event, row: FileStageCommand) => host.stage(scope(event), row))
  ipc.handle('files:stage-open', (event, row: { id: string }) => host.open(scope(event), row.id))
}
