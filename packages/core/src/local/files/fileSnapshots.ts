import { requireAgentFileAccess, requireAgentFileTreeAccess } from '../state/agentFileBoundary'
import { openAsBlob, createReadStream } from 'node:fs'
import { chmod, link, mkdir, mkdtemp, open, readdir, readFile, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { FileSink } from '../../shared/fileCipher'
import { FILE_CHUNK_BYTES, requireFileRange, requireFileRevision } from '../../shared/fileResolver'
import type { FileChunkCache } from '../../shared/fileCache'
import { createHash, randomUUID } from 'node:crypto'
import { attachmentDownloadName } from '../../shared/attachmentDownloadName.mjs'
import { cloudFileProviders } from '../../cloud/fileProviders'
import { createFileResolver, openFileBytes, type FileProviders, type FileContext, type FileHandle, type SavedFile } from '../../shared/fileResolver'
import type { AttachmentsEndpoint } from '../../cloud/attachmentsApi'
import { coreLogger } from '../../log'
const cleanupRemoteFileDirectory = async (directory: string) => rm(await requireAgentFileTreeAccess(directory), { recursive: true, force: true })

/** Raw resumable chunks share the existing private open-file cache and its stale-directory cleanup. */
export function createFileChunkCache(tempRoot: string): FileChunkCache {
  const directory = (key: string, index = 0) => {
    if (!/^(?:[0-9a-f]{32}|[0-9a-f]{64})$/.test(key) || !Number.isSafeInteger(index) || index < 0) throw new Error('Invalid file cache key')
    return join(tempRoot, `open-${key}`)
  }
  return {
    async get(key, index) {
      const file = await requireAgentFileAccess(join(directory(key, index), String(index))), info = await stat(file).catch(error => { if (error.code === 'ENOENT') return null; throw error })
      if (!info) return null
      requireFileRange(FILE_CHUNK_BYTES, 0, info.size)
      return new Uint8Array(await readFile(file))
    },
    async put(key, index, bytes) {
      requireFileRange(FILE_CHUNK_BYTES, 0, bytes.length)
      const root = directory(key, index), file = await requireAgentFileAccess(join(root, String(index)))
      await requireAgentFileAccess(root)
      await mkdir(root, { recursive: true, mode: 0o700 })
      const part = await requireAgentFileAccess(`${file}.${crypto.randomUUID()}.part`)
      await writeFile(part, bytes, { flag: 'wx', mode: 0o600 }); await rename(part, file)
    },
    clear: key => cleanupRemoteFileDirectory(directory(key)),
  }
}

/**
 * This machine's one home for the bytes agents read: `<home>/file-store/<sha256>/<name>`. A version's bytes never change, so
 * one sha is stored once, whoever asked and whatever it was called; a second name is a hard link to the same bytes.
 * Read-only, because it is shared: an agent that wants to change a file copies it. That does not make a change impossible
 * (the owner of a file can clear the flag), so every hand-out checks the hash and replaces a file that no longer holds its sha.
 */
export const fileStoreDirectory = (guguHome: string) => join(guguHome, 'file-store')
const STORED_FILE_MODE = 0o444
const storeLog = coreLogger('file-store')

/** A private bounded staging file. Only a committed, read-only snapshot can leave this sink. */
export async function createFileSink(tempRoot: string, size: number, destination?: string): Promise<FileSink & { blob(): Promise<Blob>; path(): string }> {
  requireFileRange(size, 0, 0)
  await requireAgentFileAccess(tempRoot)
  if (destination) await requireAgentFileAccess(destination)
  await mkdir(tempRoot, { recursive: true, mode: 0o700 })
  const directory = destination ? dirname(destination) : await mkdtemp(join(tempRoot, 'open-'))
  await requireAgentFileTreeAccess(directory)
  await chmod(directory, 0o700)
  const partial = destination ? `${destination}.${randomUUID()}.part` : join(directory, 'data.part'), path = destination ?? join(directory, 'data')
  await requireAgentFileAccess(partial)
  let handle = await open(partial, 'wx', 0o600)
  let written = 0, committed = false, disposed = false
  const dispose = async () => {
    if (disposed) return
    disposed = true
    try { await handle.close() } finally { if (destination) await rm(partial, { force: true }); else await cleanupRemoteFileDirectory(directory) }
  }
  return {
    async write(bytes) {
      if (committed || disposed || bytes.length > size - written) throw new Error('Invalid file staging write')
      await requireAgentFileAccess(partial)
      await handle.writeFile(bytes)
      written += bytes.length
    },
    async commit() {
      if (committed || disposed || written !== size) throw new Error('Incomplete file snapshot')
      await handle.sync()
      await handle.close()
      await requireAgentFileAccess(partial)
      await chmod(partial, destination ? 0o600 : 0o400)
      await requireAgentFileAccess(path)
      await rename(partial, path)
      handle = await open(path, 'r')
      committed = true
      return { size, dispose, async read(offset, length) {
        requireFileRange(size, offset, length)
        if (disposed) throw new Error('File snapshot is disposed')
        await requireAgentFileAccess(path)
        const bytes = new Uint8Array(length)
        let received = 0
        while (received < length) {
          const result = await handle.read(bytes, received, length - received, offset + received)
          if (!result.bytesRead) throw new Error('File snapshot was truncated')
          received += result.bytesRead
        }
        return bytes
      } }
    },
    abort: dispose,
    path() { if (!committed || disposed) throw new Error('File snapshot is not committed'); return path },
    async blob() {
      if (!committed || disposed) throw new Error('File snapshot is not committed')
      return openAsBlob(await requireAgentFileAccess(path))
    },
  }
}

/** All Node hosts configure the same resolver; desktop adds its existing local and held-SSH providers. */
export function createNodeFileResolver(root: string, endpoint: (context: FileContext) => Promise<AttachmentsEndpoint>) {
  const providers: FileProviders = { ...cloudFileProviders({ endpoint, cache: createFileChunkCache(root), sink: size => createFileSink(root, size) }), local: async () => null, ssh: async () => null }
  providers.saveTo = createFileSaver(providers)
  return createFileResolver(providers)
}

/** Downloads consume the authorized source into one final file. Random-read consumers keep snapshots. */
export function createFileSaver(providers: FileProviders): NonNullable<FileProviders['saveTo']> {
  return async (revision, context, directory, name, store = false) => {
    const path = join(directory, revision.sha256 ?? `legacy-${randomUUID()}`, attachmentDownloadName(name))
    await requireAgentFileAccess(path)
    const saved: SavedFile = { file_path: path, file_name: name, size_bytes: revision.size_bytes, sha256: revision.sha256!, content_type: revision.content_type, ...(store ? { read_only: true as const } : {}) }
    const target = dirname(path)
    const holds = async (file: string) => {
      if (!revision.sha256) return false
      const existing = await stat(file).catch(error => { if (error.code === 'ENOENT') return null; throw error })
      if (!existing?.isFile() || existing.size !== revision.size_bytes) return false
      const hash = createHash('sha256')
      for await (const bytes of createReadStream(await requireAgentFileAccess(file))) { context.signal?.throwIfAborted(); hash.update(bytes) }
      context.signal?.throwIfAborted()
      return hash.digest('hex') === revision.sha256
    }
    // A file that does not hold this sha may be someone's work: it moves aside, it is never deleted.
    const moveAside = async (file: string) => {
      const aside = join(directory, '.changed', randomUUID())
      await mkdir(aside, { recursive: true, mode: 0o700 })
      const moved = await rename(file, join(aside, basename(file))).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error })
      if (moved) storeLog.warn({ sha256: revision.sha256, name: basename(file), aside }, 'stored file no longer holds its sha: moved aside')
      else await rmdir(aside)
    }
    if (await holds(path)) {
      if (store) await chmod(path, STORED_FILE_MODE)
      return saved
    }
    if (store && revision.sha256) {
      // Under this sha, every name that no longer holds it (someone cleared the flag and edited it; hard-linked names change
      // together) is moved aside, not deleted: it may be an agent's work. One that still holds it gives this name its bytes.
      let good: string | null = null
      for (const name of await readdir(target).catch(error => { if (error.code === 'ENOENT') return [] as string[]; throw error })) {
        const same = join(target, name)
        if (name.endsWith('.part')) continue
        if (await holds(same)) { good ??= same; continue }
        // Only the name being handed out has to move now. Another that is open and locked (Windows) waits for its own hand-out.
        await moveAside(same).catch(error => {
          if (same === path) throw error
          storeLog.warn({ sha256: revision.sha256, name, code: error.code }, 'stored file no longer holds its sha: could not move it aside')
        })
      }
      // A filesystem without hard links (exFAT, some network drives) stores this name as its own copy, below.
      if (good && await link(await requireAgentFileAccess(good), path).then(() => true, error => error.code === 'EEXIST')) {
        await chmod(path, STORED_FILE_MODE)
        return saved
      }
    }
    await mkdir(target, { recursive: true, mode: 0o700 })
    // The store commits by a link from a private name: two agents saving one new file both succeed, where a rename onto the
    // other's read-only file fails on Windows.
    const written = store ? await requireAgentFileAccess(`${path}.${randomUUID()}.part`) : path
    const sink = await createFileSink(target, revision.size_bytes, written)
    try {
      const bytes = await openFileBytes(providers, revision, { ...context, download: true }, undefined, sink)
      await bytes.dispose()
      if (store) {
        await chmod(written, STORED_FILE_MODE)
        const placed = () => link(written, path).then(() => true, error => error.code === 'EEXIST' ? holds(path) : null)
        let done = await placed()
        if (done === false) { await moveAside(path); done = await placed() }
        if (done === null) {
          if (!await holds(path)) {
            await moveAside(path)
            await rename(written, path).catch(async error => { if (!await holds(path)) throw error })
          }
        } else if (!done) throw new Error('The stored file changed while it was saved')
        // Windows clears the read-only flag on the file to delete a name of it, and the published name shares that file.
        await rm(written, { force: true })
        await chmod(path, STORED_FILE_MODE)
      }
      if (!revision.sha256) {
        const hash = createHash('sha256')
        for await (const bytes of createReadStream(path)) hash.update(bytes)
        saved.sha256 = hash.digest('hex')
      }
      return saved
    } catch (error) {
      await sink.abort()
      if (store) await rm(written, { force: true })
      await rmdir(target).catch(failure => { if (!['ENOENT', 'ENOTEMPTY'].includes(failure.code)) throw failure })
      throw error
    } finally {
      if (store) await rm(written, { force: true })
    }
  }
}

/** Export only complete original bytes, with the existing portable filename and atomic replacement. */
export async function saveFileHandle(file: FileHandle, directory: string, name = file.revision.file_name, store = false): Promise<SavedFile> {
  const destination = join(directory, file.revision.sha256 ?? `legacy-${randomUUID()}`, attachmentDownloadName(name))
  await requireAgentFileAccess(destination)
  if (file.saveTo) return file.saveTo(directory, name, store)
  if (store) await rm(destination, { force: true })
  const saved = await writeFileHandle(file, destination)
  if (store) await chmod(saved.file_path, STORED_FILE_MODE)
  return { ...saved, file_name: name, ...(store ? { read_only: true as const } : {}) }
}

/** Save into this machine's file store (`fileStoreDirectory`). */
export const saveToFileStore = (file: FileHandle, guguHome: string, name = file.revision.file_name) => saveFileHandle(file, fileStoreDirectory(guguHome), name, true)

/** A trusted native save dialog may select an exact destination; the original still verifies before atomic rename. */
export async function writeFileHandle(file: FileHandle, path: string) {
  const target = dirname(path), partial = `${path}.${randomUUID()}.part`
  let output: Awaited<ReturnType<typeof open>> | undefined
  let createdDirectory: string | undefined
  let createdPartial = false
  const hash = createHash('sha256'); let size = 0
  try {
    requireFileRevision(file.revision)
    await requireAgentFileAccess(path)
    createdDirectory = await mkdir(target, { recursive: true, mode: 0o700 })
    await requireAgentFileAccess(partial)
    output = await open(partial, 'wx', 0o600)
    createdPartial = true
    for await (const chunk of file.stream()) { size += chunk.length; if (size > file.revision.size_bytes) throw new Error('File export size changed'); hash.update(chunk); await output.writeFile(chunk) }
    const observedSha = hash.digest('hex')
    if (size !== file.revision.size_bytes || file.revision.sha256 !== null && observedSha !== file.revision.sha256) throw new Error('File export SHA-256 mismatch')
    await output.sync(); await output.close(); await requireAgentFileAccess(path); await rename(partial, path)
    return { file_path: path, file_name: basename(path), size_bytes: size, sha256: observedSha, content_type: file.revision.content_type }
  } catch (error) {
    await output?.close().catch(() => undefined); if (createdPartial) await rm(await requireAgentFileAccess(partial), { force: true })
    if (createdDirectory === target) await rmdir(target).catch(failure => { if (!['ENOENT', 'ENOTEMPTY'].includes(failure.code)) throw failure }); throw error
  }
  finally { await file.dispose() }
}
