import { createReadStream } from 'node:fs'
import { chmod, mkdir, rename, stat } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { createFileSink } from './fileSnapshot'
import type { AttachmentDeclareRequest, createAttachmentUploadHost } from './attachmentUploadHost'
import type { SelectedProjectFile, ProjectFileMessage } from './projectFilePublication'
import { sanitizeRemoteFileName } from './remoteFileOpen'
import { FileIntegrityError, fileReadFailure, fileRefKey, requireFileRange, requireFileRevision, type FileBytes, type FileContext, type FilePreview, type FileProviders, type FileRevision, type FileStageCommand } from '@gugu/core/shared/fileResolver'

/** Opaque capabilities stay within the issuing renderer and account. Bytes use the existing invoke bus and FileSink. */
export function createNativeFileHost(deps: {
  attachments?: ReturnType<typeof createAttachmentUploadHost>
  root: string; owner(): Promise<string | null>; alive(scope: number): boolean
  local: FileProviders['local']; ssh: FileProviders['ssh']; openPath(path: string): Promise<string>
  published(directory: string): void; maxBytes?: number
  publish?(chatId: string, file: SelectedProjectFile, owner: string, message?: ProjectFileMessage, task?: { itemId?: string }): Promise<unknown>
  /** A task attachment's own copy for the agent (`writeTaskCopy`): its path. */
  taskCopy?(name: string, bytes: Uint8Array, mimeType?: string): Promise<{ path: string; name: string; size: number; mimeType?: string }>
  publication?(chatId: string, owner: string): Promise<boolean>
  /** This machine's bytes of a sha (`localCopy`): asked only for a read already authorized. */
  stored?(sha256: string): Promise<Blob | null>
  /**
   * This machine's bytes reach the renderer at an address (`createBytesPreview`, `gugu-preview://<id>/<sha>`), never over
   * this IPC: a `<video>` reads its ranges, a Blob is fetched whole. `release` takes the address down.
   */
  serve(sha256: string, contentType: string, file: Pick<FileBytes, 'size' | 'read'>): Promise<{ url: string; release(): void }>
  /**
   * The desktop renderer's cloud reads, run here (`desktopFileAccess` providers): main signs, reads, verifies and keeps
   * the snapshot; the renderer reads it at its address. `preview`: a video's signed address, or a small preview's bytes.
   */
  cloud?: {
    read(revision: FileRevision, context: FileContext): Promise<FileBytes>
    preview(revision: FileRevision, context: FileContext): Promise<{ url: string; expiresAt: number } | Uint8Array>
    expiredPreview(preview: FilePreview, context: FileContext): Promise<Uint8Array>
  }
  /** A file saved where the person picks, from this machine's copy (`desktopFileAccess.download`); the scope's window asks. */
  download?(scope: number, context: FileContext, name: string): Promise<{ saved: boolean } | { status: string }>
}) {
  type Entry = { scope: number; epoch: number; owner: string; file?: FileBytes; release?: () => void; url?: string; context?: string; name?: string; size?: number; sha?: string;
    sink?: Awaited<ReturnType<typeof createFileSink>>; hash?: ReturnType<typeof createHash>; written?: number; path?: string; busy?: boolean }
  const entries = new Map<string, Entry>()
  /** Cloud reads still running, by the reader's name for them: cancelled when the reader lets go (`cancel`). */
  const running = new Map<string, { scope: number; stop: AbortController }>()
  let lastOwner: string | null = null
  const epochs = new Map<number, number>()
  const epochOf = (scope: number) => { const value = epochs.get(scope) ?? 0; epochs.set(scope, value); return value }
  const check = async (scope: number, owner: string, epoch: number) => {
    if (!deps.alive(scope) || epoch !== epochOf(scope) || owner !== await deps.owner()) throw new Error('File reader account or window changed')
  }
  const drop = async (scope?: number) => {
    for (const id of scope === undefined ? epochs.keys() : [scope]) epochs.set(id, epochOf(id) + 1)
    for (const [id, read] of running) if (scope === undefined || read.scope === scope) { running.delete(id); read.stop.abort(new Error('File reader account or window changed')) }
    await Promise.all([...entries].filter(([, entry]) => scope === undefined || entry.scope === scope).map(async ([id, entry]) => {
      entries.delete(id); entry.release?.(); await entry.file?.dispose(); await entry.sink?.abort()
    }))
  }
  const entryFor = async (scope: number, id: string) => {
    const entry = entries.get(id)
    if (!entry || entry.scope !== scope) throw new Error('File handle is unavailable')
    await check(scope, entry.owner, entry.epoch); return entry
  }
  return { drop,
    async attachment(scope: number, request: ({ op: 'declare' } & AttachmentDeclareRequest) | { op: 'drop' | 'retry'; messageId: string }) {
      const epoch = epochOf(scope), owner = await deps.owner()
      if (!owner || !deps.attachments) throw new Error('Attachment uploader is unavailable')
      await check(scope, owner, epoch)
      const result = request.op === 'declare' ? (await deps.attachments.declare(request)).declared
        : await deps.attachments[request.op](request.messageId)
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
    /** `progress`: the reader's name for this read; `report` hands it how far the bytes have come (`files:read-progress`). */
    async read(scope: number, context: FileContext, request: { op: string; id?: string; revision?: FileRevision; offset?: number; length?: number; progress?: string; sha256?: string; contentType?: string; read?: string; preview?: FilePreview; name?: string },
      report?: (progress: { id: string; done: number; total: number; stalled?: true }) => void) {
      const epoch = epochOf(scope), owner = await deps.owner(); if (!owner || context.actor.accountId !== owner) throw new Error('File reader is not signed in')
      const key = JSON.stringify([context.actor.accountId, context.actor.actorId, fileRefKey(context.ref)])
      /** This machine's bytes, verified: kept for this reader at an address until it disposes them. */
      const served = async (sha256: string, contentType: string, file: FileBytes) => {
        try { await check(scope, owner, epoch) } catch (error) { await file.dispose(); throw error }
        const { url, release } = await deps.serve(sha256, contentType, file)
        const id = randomUUID(); entries.set(id, { scope, epoch, owner, context: key, file, release, url }); return { id, size: file.size, url }
      }
      if (request.op === 'cloud' || request.op === 'cloud-preview' || request.op === 'cloud-expired-preview') {
        // A failure comes back as a value (`fileReadFailure`): the reader branches on its kind, which an invoke error loses.
        const cloud = deps.cloud, name = request.read
        if (!cloud || typeof name !== 'string' || running.has(name)) throw new Error('Cloud file reads are unavailable')
        const stop = new AbortController(); running.set(name, { scope, stop })
        const named = request.progress
        const reading: FileContext = { ...context, signal: stop.signal,
          ...(typeof named === 'string' && report ? { progress: (done: number, total: number, stalled?: true) => report({ id: named, done, total, ...(stalled ? { stalled } : {}) }) } : {}) }
        try {
          if (request.op === 'cloud-expired-preview') {
            const bytes = await cloud.expiredPreview(request.preview!, reading); await check(scope, owner, epoch); return { bytes }
          }
          const revision = request.revision!; requireFileRevision(revision)
          if (request.op === 'cloud-preview') { const shown = await cloud.preview(revision, reading); await check(scope, owner, epoch); return shown instanceof Uint8Array ? { bytes: shown } : shown }
          const file = await cloud.read(revision, reading)
          // The verified snapshot, at its address; a historical object without a sha is read over this channel instead.
          const flags = { ...(file.acknowledged ? { ack: true } : {}), ...(file.here ? { here: true } : {}) }
          if (revision.sha256) return { ...await served(revision.sha256, revision.content_type, file), ...flags }
          try { await check(scope, owner, epoch) } catch (error) { await file.dispose(); throw error }
          const id = randomUUID(); entries.set(id, { scope, epoch, owner, context: key, file }); return { id, size: file.size, ...flags }
        } catch (error) { return { failed: fileReadFailure(error) } } finally { running.delete(name) }
      }
      if (request.op === 'download') {
        if (!deps.download || typeof request.name !== 'string' || !request.name) throw new Error('File download is unavailable')
        try { const done = await deps.download(scope, context, request.name); await check(scope, owner, epoch); return done }
        catch (error) { return { failed: fileReadFailure(error) } }
      }
      if (request.op === 'cancel') {
        const read = typeof request.read === 'string' ? running.get(request.read) : undefined
        if (read?.scope === scope) read.stop.abort(new Error('File read cancelled'))
        return
      }
      if (request.op === 'stored') {
        const sha256 = request.sha256!
        const blob = await deps.stored?.(sha256) ?? null
        if (!blob) return null
        const contentType = typeof request.contentType === 'string' ? request.contentType : ''
        return served(sha256, contentType, { size: blob.size, read: async (offset, length) => new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer()), dispose: async () => {} })
      }
      if (request.op === 'local' || request.op === 'open' || request.op === 'ssh') {
        const named = request.progress
        if (typeof named === 'string' && report) context = { ...context, progress: (done, total, stalled) => report({ id: named, done, total, ...(stalled ? { stalled } : {}) }) }
        const local = request.op === 'ssh' ? null : await deps.local(context)
        await check(scope, owner, epoch)
        if (request.op === 'local') return local?.revision ?? null
        const revision = request.revision!; requireFileRevision(revision)
        if (local && JSON.stringify([local.revision.item_id, local.revision.version, local.revision.sha256, local.revision.size_bytes]) !==
          JSON.stringify([revision.item_id, revision.version, revision.sha256, revision.size_bytes])) throw new Error('Local file revision changed')
        const file = request.op === 'ssh' ? await deps.ssh(revision, context) : await local?.open()
        if (!file) return null
        if (request.op === 'open') return served(revision.sha256!, revision.content_type, file)
        try { await check(scope, owner, epoch) } catch (error) { await file.dispose(); throw error }
        const id = randomUUID(); entries.set(id, { scope, epoch, owner, context: key, file }); return { id, size: file.size }
      }
      const entry = await entryFor(scope, request.id!)
      if (!entry.file || entry.context !== key) throw new Error('File handle belongs to another reader')
      if (request.op === 'dispose') { entries.delete(request.id!); entry.release?.(); await entry.file.dispose(); return }
      // Bytes shown before the server acknowledged the read: how that acknowledgement ended, as a value.
      if (request.op === 'ack') { try { await entry.file.acknowledged; return null } catch (error) { return { failed: fileReadFailure(error) } } }
      if (request.op !== 'read') throw new Error('Unknown file operation')
      if (entry.url) throw new Error('This file is read at its address')
      requireFileRange(entry.file.size, request.offset!, request.length!)
      const bytes = await entry.file.read(request.offset!, request.length!); await check(scope, owner, entry.epoch); return bytes
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
        if (entry.written !== entry.size || entry.hash!.digest('hex') !== entry.sha) throw new FileIntegrityError()
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
  ipc.handle('files:read', (event, row: FileContext & Parameters<typeof host.read>[2]) => host.read(scope(event), { actor: row.actor, ref: row.ref }, row,
    (progress) => { if (!event.sender.isDestroyed()) event.sender.send('files:read-progress', progress) }))
  ipc.handle('files:stage', (event, row: FileStageCommand) => host.stage(scope(event), row))
  ipc.handle('files:stage-open', (event, row: { id: string }) => host.open(scope(event), row.id))
}
