import { requireAgentFileAccess, requireAgentFileTreeAccess } from '../state/agentFileBoundary'
import { constants, openAsBlob, createReadStream } from 'node:fs'
import { chmod, copyFile, link, mkdir, mkdtemp, open, readdir, readFile, rename, rm, rmdir, stat, utimes, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { FileSink } from '../../shared/fileCipher'
import { FILE_CHUNK_BYTES, FileIntegrityError, requireFileRange, requireFileRevision } from '../../shared/fileResolver'
import type { FileChunkCache } from '../../shared/fileCache'
import { byteBudget, trimToBytes, type BudgetRole } from '../../shared/byteBudget'
import { createHash, randomUUID } from 'node:crypto'
import { attachmentDownloadName } from '../../shared/attachmentDownloadName.mjs'
import { cloudFileProviders } from '../../cloud/fileProviders'
import { createFileResolver, openFileBytes, type FileBytes, type FileProviders, type FileContext, type FileHandle, type SavedFile } from '../../shared/fileResolver'
import type { AttachmentsEndpoint } from '../../cloud/attachmentsApi'
import { coreLogger } from '../../log'
const cleanupRemoteFileDirectory = async (directory: string) => rm(await requireAgentFileTreeAccess(directory), { recursive: true, force: true })

/**
 * @@@positional-chunks - a read's chunks are kept in one file, `<temp>/open-<key>/data`, each written once at its own
 * offset (`index * FILE_CHUNK_BYTES`): the connections of a read write at the same time, with no file made or renamed
 * per chunk and no queue between them. `done` beside it lists the chunks that are there, for a read that stopped to go
 * on from them. A chunk is never written twice: a second put of one must bring the same bytes, so what a reader hashed
 * is what the file holds, and a complete file never changes again and can be handed over whole (`file`).
 */
type StagedChunks = {
  data: Awaited<ReturnType<typeof open>>; done: Awaited<ReturnType<typeof open>> | null; path: string
  lengths: Map<number, number>; writing: Map<number, Promise<void>>
  /** What is reading or writing now, and whether `clear` has taken the file away: it waits for the former, then closes. */
  active: Set<Promise<unknown>>; cleared: boolean
}
// Cache instances in one process share directories: one open file per key, whoever asks.
const stagedChunks = new Map<string, Promise<StagedChunks | null>>()
// Opening a key's file and clearing it take turns: a clear must not remove the directory under an open's path checks.
const stagedTurns = new Map<string, Promise<unknown>>()
function stagedTurn<T>(key: string, turn: () => Promise<T>): Promise<T> {
  const result = (stagedTurns.get(key) ?? Promise.resolve()).then(turn)
  const tail = result.then(() => {}, () => {})
  stagedTurns.set(key, tail)
  void tail.then(() => { if (stagedTurns.get(key) === tail) stagedTurns.delete(key) })
  return result
}
// Normalize the stable parent, not the removable child: aliases of one cache share the file. Checked once per directory
// until it is cleared: a chunk's read or write goes through the file already open, not through its path.
const stagedKeys = new Map<string, Promise<string>>()
const stagedKey = (directory: string) => {
  let key = stagedKeys.get(directory)
  if (!key) {
    const checking = key = requireAgentFileAccess(dirname(directory)).then(parent => join(parent, basename(directory)))
    stagedKeys.set(directory, checking)
    checking.catch(() => { if (stagedKeys.get(directory) === checking) stagedKeys.delete(directory) })
  }
  return key
}
async function stagedIn(directory: string, create: boolean): Promise<StagedChunks | null> {
  const key = await stagedKey(directory)
  const openStaged = async (): Promise<StagedChunks | null> => {
    const root = await requireAgentFileAccess(directory), path = await requireAgentFileAccess(join(root, 'data'))
    if (!create && !await stat(path).catch(error => { if (error.code === 'ENOENT') return null; throw error })) return null
    await mkdir(root, { recursive: true, mode: 0o700 })
    // A complete file a sink took is read-only (it is the sink's file too): it is only read from here on.
    const writable = await open(path, constants.O_RDWR | constants.O_CREAT, 0o600)
      .catch(error => { if (error.code === 'EACCES' || error.code === 'EPERM') return null; throw error })
    const record = join(root, 'done'), lengths = new Map<number, number>()
    const recorded = await readFile(record, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error })
    for (const line of recorded.split('\n')) {
      const [index, length] = line.split(' ').map(Number)
      if (!line || !Number.isSafeInteger(index) || !Number.isSafeInteger(length)) continue
      requireFileRange(FILE_CHUNK_BYTES, 0, length!); lengths.set(index!, length!)
    }
    return {
      data: writable ?? await open(path, 'r'), done: writable ? await open(record, 'a', 0o600) : null, path,
      lengths, writing: new Map(), active: new Set(), cleared: false,
    }
  }
  let staged = stagedChunks.get(key)
  // Nothing was there when it was last looked for (or it could not be opened): look again.
  if (staged && await staged.catch(() => null) === null) staged = undefined
  if (!staged) {
    const opening = staged = stagedTurn(key, openStaged)
    stagedChunks.set(key, opening)
    const forget = () => { if (stagedChunks.get(key) === opening) stagedChunks.delete(key) }
    void opening.then(found => { if (!found) forget() }, forget)
  }
  return staged
}
/** `use` the open file, unless `clear` took it away meanwhile (`CLEARED`: the caller looks for the file again). */
const CLEARED = Symbol('cleared')
async function withStaged<T>(staged: StagedChunks, use: () => Promise<T>): Promise<T | typeof CLEARED> {
  if (staged.cleared) return CLEARED
  const using = use()
  staged.active.add(using)
  try { return await using } finally { staged.active.delete(using) }
}
const readStaged = async (staged: StagedChunks, index: number): Promise<Uint8Array> => {
  const bytes = new Uint8Array(staged.lengths.get(index)!)
  for (let read = 0; read < bytes.length;) {
    const { bytesRead } = await staged.data.read(bytes, read, bytes.length - read, index * FILE_CHUNK_BYTES + read)
    if (!bytesRead) throw new Error('Invalid cached file chunk')
    read += bytesRead
  }
  return bytes
}

/** Raw resumable chunks share the existing private open-file cache and its stale-directory cleanup. */
export function createFileChunkCache(tempRoot: string): FileChunkCache {
  const directory = (key: string, index = 0) => {
    if (!/^(?:[0-9a-f]{32}|[0-9a-f]{64})$/.test(key) || !Number.isSafeInteger(index) || index < 0) throw new Error('Invalid file cache key')
    return join(tempRoot, `open-${key}`)
  }
  return {
    async get(key, index) {
      for (;;) {
        const staged = await stagedIn(directory(key, index), false)
        if (!staged) return null
        const found = await withStaged(staged, async () => {
          await staged.writing.get(index)?.catch(() => undefined)
          return staged.lengths.has(index) ? readStaged(staged, index) : null
        })
        if (found !== CLEARED) return found
      }
    },
    async put(key, index, bytes) {
      requireFileRange(FILE_CHUNK_BYTES, 0, bytes.length)
      for (;;) {
        const staged = (await stagedIn(directory(key, index), true))!
        const put = await withStaged(staged, async () => {
          // One writer per chunk: whoever comes second waits, then brings the same bytes or is refused.
          await staged.writing.get(index)?.catch(() => undefined)
          if (staged.lengths.has(index)) {
            const kept = await readStaged(staged, index)
            if (kept.length !== bytes.length || Buffer.compare(kept, bytes)) throw new FileIntegrityError('Cached file chunk')
            return
          }
          if (!staged.done) throw new Error('Invalid cached file chunk')
          const done = staged.done
          const written = (async () => {
            const at = index * FILE_CHUNK_BYTES
            for (let wrote = 0; wrote < bytes.length;) {
              wrote += (await staged.data.write(bytes, wrote, bytes.length - wrote, at + wrote)).bytesWritten
            }
            await done.appendFile(`${index} ${bytes.length}\n`)
            staged.lengths.set(index, bytes.length)
          })()
          staged.writing.set(index, written)
          try { await written } finally { staged.writing.delete(index) }
        })
        if (put !== CLEARED) return
      }
    },
    async clear(key) {
      const root = directory(key), name = await stagedKey(root)
      const staged = await stagedChunks.get(name)?.catch(() => null)
      stagedChunks.delete(name); stagedKeys.delete(root)
      if (staged) staged.cleared = true
      await stagedTurn(name, async () => {
        if (staged) { await Promise.allSettled([...staged.active]); await staged.data.close(); await staged.done?.close() }
        await cleanupRemoteFileDirectory(root)
      })
    },
    async file(key, chunks) {
      const staged = await stagedIn(directory(key), false)
      if (!staged || staged.cleared || staged.lengths.size !== chunks) return null
      for (let index = 0; index < chunks; index++) if (!staged.lengths.has(index)) return null
      return staged.path
    },
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

// @@@file-sinks - a read in flight is staged in a private `read-*` directory under the temp root, owned by the one process
// that made it and removed when its read is let go. A process killed outright cannot let go: a sink older than the running
// process is such a leftover, which startup removes whatever its age (published `open-*` files keep their own lifetime).
const FILE_SINK_PREFIX = 'read-'

/** Removes the sinks of processes that are gone: every sink made before `startedAt`, this process's start. */
export async function cleanupOrphanedFileSinks(tempRoot: string, startedAt: number): Promise<void> {
  const entries = await readdir(tempRoot, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return []
    throw error
  })
  await Promise.all(entries.filter(entry => entry.isDirectory() && entry.name.startsWith(FILE_SINK_PREFIX)).map(async entry => {
    const directory = join(tempRoot, entry.name)
    if ((await stat(directory)).mtimeMs < startedAt) await cleanupRemoteFileDirectory(directory)
  }))
}

/** A private bounded staging file. Only a committed, read-only snapshot can leave this sink. */
export async function createFileSink(tempRoot: string, size: number, destination?: string): Promise<FileSink & { blob(): Promise<Blob>; path(): string }> {
  requireFileRange(size, 0, 0)
  await requireAgentFileAccess(tempRoot)
  if (destination) await requireAgentFileAccess(destination)
  await mkdir(tempRoot, { recursive: true, mode: 0o700 })
  const directory = destination ? dirname(destination) : await mkdtemp(join(tempRoot, FILE_SINK_PREFIX))
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
    // The same file under this sink's private name: a link, so nothing is written twice; a copy where the two are on
    // different volumes or the filesystem has no links.
    async adopt(staged) {
      if (committed || disposed || written) throw new Error('Invalid file staging adoption')
      if ((await stat(await requireAgentFileAccess(staged))).size !== size) throw new Error('Incomplete file snapshot')
      await handle.close(); await rm(partial)
      await link(staged, partial).catch(error => {
        if (!['EXDEV', 'EPERM', 'ENOTSUP', 'EMLINK'].includes(error.code)) throw error
        return copyFile(staged, partial, constants.COPYFILE_EXCL)
      })
      handle = await open(partial, 'r+'); written = size
    },
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

/**
 * The one way a file is written where someone says: `fill` makes it under a private name beside `path`; it is then given
 * `mode`, synced and renamed into place. A write that fails leaves nothing at `path` and no private name behind.
 */
export async function writeFileAt(path: string, mode: number, fill: (partial: string) => Promise<void>): Promise<void> {
  const target = dirname(path), partial = `${path}.${randomUUID()}.part`
  let createdDirectory: string | undefined
  try {
    await requireAgentFileAccess(path)
    createdDirectory = await mkdir(target, { recursive: true, mode: 0o700 })
    await requireAgentFileAccess(partial)
    await fill(partial)
    await chmod(partial, mode)
    const written = await open(partial, 'r+')
    try { await written.sync() } finally { await written.close() }
    await requireAgentFileAccess(path); await rename(partial, path)
  } catch (error) {
    await rm(partial, { force: true })
    if (createdDirectory === target) await rmdir(target).catch(failure => { if (!['ENOENT', 'ENOTEMPTY'].includes(failure.code)) throw failure }); throw error
  }
}

/**
 * A trusted native save dialog may select an exact destination; the original still verifies before atomic rename. `mode`:
 * private by default; a file the person saves for themselves is `0o644`, as a browser saves it.
 */
export async function writeFileHandle(file: FileHandle, path: string, mode = 0o600) {
  const hash = createHash('sha256'); let size = 0, observedSha = ''
  try {
    requireFileRevision(file.revision)
    await writeFileAt(path, mode, async partial => {
      const output = await open(partial, 'wx', mode)
      try {
        for await (const chunk of file.stream()) {
          size += chunk.length
          if (size > file.revision.size_bytes) throw new Error('File export size changed')
          hash.update(chunk); await output.writeFile(chunk)
        }
      } finally { await output.close() }
      // Checked before it is given its name: bytes that are not the pinned ones never appear at `path`.
      observedSha = hash.digest('hex')
      const { size_bytes: expected, sha256: pinned } = file.revision
      if (size !== expected || pinned !== null && observedSha !== pinned) throw new FileIntegrityError('File export')
    })
    return { file_path: path, file_name: basename(path), size_bytes: size, sha256: observedSha, content_type: file.revision.content_type }
  }
  finally { await file.dispose() }
}
/** Bytes already verified (this machine's copy of a version), written the same way. */
export async function writeFileBytes(bytes: Pick<FileBytes, 'size' | 'read'>, path: string, mode: number): Promise<void> {
  await writeFileAt(path, mode, async partial => {
    const output = await open(partial, 'wx', mode)
    try {
      for (let offset = 0; offset < bytes.size; offset += FILE_CHUNK_BYTES) {
        await output.writeFile(await bytes.read(offset, Math.min(FILE_CHUNK_BYTES, bytes.size - offset)))
      }
    } finally { await output.close() }
  })
}

/** Where `directory` (the file store) holds a complete file of `sha256`, checked against it. */
async function verifiedCopy(directory: string, sha256: string): Promise<string | null> {
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error('Invalid stored file SHA-256')
  const held = await requireAgentFileAccess(join(directory, sha256))
  for (const name of await readdir(held).catch(error => { if (error.code === 'ENOENT') return [] as string[]; throw error })) {
    if (name.endsWith('.part')) continue
    const path = await requireAgentFileAccess(join(held, name))
    if (!(await stat(path)).isFile()) continue
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(path)) hash.update(chunk)
    if (hash.digest('hex') === sha256) return path
  }
  return null
}
/** A verified original already held by this device; partial or changed files cannot resume an upload. */
export async function storedCopy(guguHome: string, sha256: string): Promise<Blob | null> {
  const path = await verifiedCopy(fileStoreDirectory(guguHome), sha256)
  return path ? openAsBlob(path) : null
}

/**
 * What this desktop's window read over the network: `<home>/file-cache/<sha256>/<name>`, beside the file store and laid
 * out like it. Unlike the store it is only a cache: nothing here is anyone's only copy and no path into it is handed out
 * (the store also holds files this machine sent and files agents were given by path), so it has a byte budget, and past it
 * the least recently read copies are dropped (`trimToBytes`, the page cache's own rule). Whoever reads a copy holds it
 * until it lets go (`dispose`): a copy being read, or being written, is never dropped.
 */
export const fileCacheDirectory = (guguHome: string) => join(guguHome, 'file-cache')
const FILE_CACHE_BYTES = 10 * 1024 ** 3
export function createFileCache(directory: string, maxBytes = FILE_CACHE_BYTES) {
  const held = new Map<string, number>(), filling = new Map<string, Promise<unknown>>()
  const hold = (sha256: string) => { held.set(sha256, (held.get(sha256) ?? 0) + 1) }
  const release = (sha256: string) => {
    const left = held.get(sha256)! - 1
    if (left) held.set(sha256, left); else held.delete(sha256)
  }
  /** One sha's copy: its size once (its names are links to the same bytes), and when it was last read. */
  const copyOf = async (name: string) => {
    const names = (await readdir(join(directory, name)).catch(() => [] as string[])).filter(file => !file.endsWith('.part'))
    const files = await Promise.all(names.map(file => stat(join(directory, name, file)).catch(() => null)))
    const file = files.find(info => info?.isFile())
    return file ? { size: file.size, readAt: Math.max(...files.map(info => info?.atimeMs ?? 0)) } : null
  }
  /**
   * Where the cache holds `sha256`. Not hashed again: a copy is verified as it is written, comes into place only whole,
   * is read-only, and nothing but this cache writes here (the store, which hands out paths, checks on every hand-out).
   */
  const cachedPath = async (sha256: string) => {
    if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error('Invalid stored file SHA-256')
    const copy = await requireAgentFileAccess(join(directory, sha256))
    for (const name of await readdir(copy).catch(error => { if (error.code === 'ENOENT') return [] as string[]; throw error })) {
      if (!name.endsWith('.part') && (await stat(join(copy, name))).isFile()) return join(copy, name)
    }
    return null
  }
  const trim = async () => {
    const names = await readdir(directory).catch(error => { if (error.code === 'ENOENT') return [] as string[]; throw error })
    if (names.length) await requireAgentFileTreeAccess(directory)
    const copies = await Promise.all(names.map(async name => ({
      name, copy: /^[0-9a-f]{64}$/.test(name) ? await copyOf(name) : null,
    })))
    copies.sort((a, b) => (b.copy?.readAt ?? 0) - (a.copy?.readAt ?? 0))
    // A copy someone holds counts like any other and is never dropped, even past the budget. What is not a complete
    // copy (an interrupted write, a file moved aside) is dropped, unless it is being written.
    const roleOf = (name: string, complete: boolean): BudgetRole =>
      complete ? held.has(name) ? 'held' : 'budget' : held.has(name) ? 'keep' : 'drop'
    return trimToBytes(copies, maxBytes,
      async ({ name, copy }) => ({ role: roleOf(name, !!copy), size: () => copy!.size }),
      ({ name }) => rm(join(directory, name), { recursive: true, force: true }))
  }
  const budget = byteBudget(maxBytes, trim, error => storeLog.warn({ error }, 'file cache trim failed'))
  return { directory, idle: budget.idle,
    /**
     * The cached copy of `sha256`, held until disposed, and where it is (`path`, for a clone; never handed out); `null`
     * when the cache has none. `fill`: write it first when it is missing (into `directory`, the way the store is written).
     */
    async read(sha256: string, fill?: () => Promise<unknown>): Promise<FileBytes & { path: string } | null> {
      hold(sha256)
      try {
        let path = await cachedPath(sha256)
        // One read of a copy over the network at a time: whoever else wants it waits and takes what that read wrote.
        if (!path && fill && filling.has(sha256)) {
          await filling.get(sha256)!.catch(() => undefined)
          path = await cachedPath(sha256)
        }
        if (!path && fill) {
          const mine = fill()
          filling.set(sha256, mine)
          try { await mine } finally { if (filling.get(sha256) === mine) filling.delete(sha256) }
          path = await cachedPath(sha256)
          if (path) budget.wrote((await stat(path)).size)
        }
        if (!path) { release(sha256); return null }
        // Read now: the least recently read copy is the first to go.
        const info = await stat(path); await utimes(path, new Date(), info.mtime)
        const blob = await openAsBlob(path)
        let disposed = false
        return {
          path, size: blob.size, here: true,
          read: async (offset, length) => new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer()),
          dispose: async () => { if (!disposed) { disposed = true; release(sha256); budget.released() } },
        }
      } catch (error) { release(sha256); throw error }
    },
  }
}

/**
 * A file this machine sent from its own disk is not copied: `<home>/file-origins/<sha256>` names where it is. Every hand-out
 * hashes it again. One that no longer holds its sha (changed, moved or deleted) is no copy: a reader then reads it from where
 * else it is kept, and an upload still owing those bytes fails, saying so (`FileOriginChangedError`).
 */
const originOf = (guguHome: string, sha256: string) => join(guguHome, 'file-origins', sha256)
export class FileOriginChangedError extends Error {
  readonly code = 'original_changed'
  constructor(readonly path: string) { super(`The original file changed or was removed before its upload finished: ${path}`) }
}
export async function recordFileOrigin(guguHome: string, sha256: string, path: string): Promise<void> {
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error('Invalid stored file SHA-256')
  const record = await requireAgentFileAccess(originOf(guguHome, sha256)), part = `${record}.${randomUUID()}.part`
  await mkdir(dirname(record), { recursive: true, mode: 0o700 })
  await writeFile(part, JSON.stringify({ path }), { mode: 0o600 }); await rename(part, record)
}
/** This machine's bytes of `sha256`: the store's copy, else the original it sent. `strict`: an original that changed throws. */
export async function localCopy(guguHome: string, sha256: string, strict = false): Promise<Blob | null> {
  const stored = await storedCopy(guguHome, sha256)
  if (stored) return stored
  const text = await readFile(await requireAgentFileAccess(originOf(guguHome, sha256)), 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error })
  if (text === null) return null
  const { path } = JSON.parse(text) as { path: string }
  // An original that cannot be opened any more (moved, deleted, no longer readable) holds no bytes here.
  // (openAsBlob throws a missing file at once, not through its promise.)
  const blob = await (async () => openAsBlob(await requireAgentFileAccess(path)))().catch(() => null)
  const hash = createHash('sha256')
  if (blob) for await (const chunk of blob.stream()) hash.update(chunk)
  if (blob && hash.digest('hex') === sha256) return blob
  if (strict) throw new FileOriginChangedError(path)
  return null
}

/** Keep outgoing bytes through the same verified, atomic, read-only store used for downloaded originals. */
export async function storeBytes(guguHome: string, sha256: string, name: string, bytes: Blob): Promise<void> {
  if (await storedCopy(guguHome, sha256)) return
  await storeFileBytes(fileStoreDirectory(guguHome), sha256, name, bytes.type, { size: bytes.size, read: async (offset, length) => new Uint8Array(await bytes.slice(offset, offset + length).arrayBuffer()) })
}
/** Bytes into the store or the file cache (`directory`), checked against the sha as they are written. */
export async function storeFileBytes(directory: string, sha256: string, name: string, contentType: string, bytes: Pick<FileBytes, 'size' | 'read'>): Promise<void> {
  const revision = { source: 'managed-object' as const, file_name: name, content_type: contentType || 'application/octet-stream', size_bytes: bytes.size, sha256 }
  const source = async () => ({ size: bytes.size, read: bytes.read, dispose: async () => {} })
  const save = createFileSaver({ local: async () => null, metadata: async () => ({ status: 'ready', revision }), managed: source, ssh: async () => null, temporary: source })
  // The saver consumes these local bytes; its ref is a placeholder, never a cloud read or authorization.
  await save(revision, { ref: { message_id: sha256 }, actor: { accountId: 'local', actorId: 'local' } }, directory, name, true)
}
