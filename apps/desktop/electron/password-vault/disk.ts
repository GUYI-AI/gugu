import { constants } from 'node:fs'
import { lstat, mkdir, open, readdir, rename, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, join, parse as parsePath, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { VaultError } from './contracts'
import type { VaultFeatureOperation } from './feature-guard'

const MAX_BYTES = 32 * 1024 * 1024
const absent = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT'
const diskError = (error: unknown) => error instanceof VaultError && ['UNAVAILABLE', 'CANCELLED'].includes(error.code) ? error : new VaultError('STORAGE_FAILED')
/** One Electron-main writer. All temporary bytes are already ciphertext under the registered root. */
export class VaultDisk {
  readonly #operation = new AsyncLocalStorage<VaultFeatureOperation>()
  constructor(readonly root: string, private readonly ready: () => Promise<void>) {
    if (!isAbsolute(root) || resolve(root) !== root) throw new VaultError('INVALID_INPUT')
  }
  get feature(): VaultFeatureOperation | undefined { return this.#operation.getStore() }
  withFeature<T>(feature: VaultFeatureOperation, action: () => Promise<T>): Promise<T> { return this.#operation.run(feature, action) }
  private current(): void { this.feature?.assertCurrent() }
  private beforeWrite(): void { this.feature?.beforeWrite() }
  private path(relative: string): string {
    const path = resolve(this.root, relative)
    if (!path.startsWith(this.root + '/')) throw new VaultError('INVALID_INPUT')
    return path
  }
  private async directory(path: string, create: boolean): Promise<void> {
    let cursor = parsePath(path).root
    for (const part of path.slice(cursor.length).split('/').filter(Boolean)) {
      cursor = join(cursor, part)
      let info
      try { info = await lstat(cursor); this.current() }
      catch (error) {
        if (!create || !absent(error)) throw error
        this.beforeWrite()
        try { await mkdir(cursor, { mode: 0o700 }) } catch (failure) { if ((failure as NodeJS.ErrnoException).code !== 'EEXIST') throw failure }
        this.current(); info = await lstat(cursor); this.current()
      }
      if (!info.isDirectory() || info.isSymbolicLink()) throw new VaultError('STORAGE_FAILED')
      if (cursor === this.root || cursor.startsWith(this.root + '/')) {
        if ((info.mode & 0o077) !== 0) throw new VaultError('STORAGE_FAILED')
      }
    }
  }
  async read(relative: string): Promise<Buffer | null> {
    await this.ready(); this.current()
    const path = this.path(relative)
    try {
      await this.directory(dirname(path), false)
      this.current()
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
      let bytes: Buffer
      try {
        this.current(); const info = await handle.stat(); this.current()
        if (!info.isFile() || info.nlink !== 1 || info.size > MAX_BYTES || (info.mode & 0o077) !== 0) throw new VaultError('STORAGE_FAILED')
        bytes = await handle.readFile()
        try { this.current() } catch (error) { bytes.fill(0); throw error }
        if (bytes.length > MAX_BYTES) { bytes.fill(0); throw new VaultError('STORAGE_FAILED') }
      } finally { await handle.close() }
      try { this.current() } catch (error) { bytes.fill(0); throw error }
      return bytes
    } catch (error) { if (absent(error)) return null; throw diskError(error) }
  }
  async list(relative: string): Promise<string[]> {
    await this.ready(); this.current()
    const path = relative === '.' ? this.root : this.path(relative)
    try { await this.directory(path, false); this.current(); const files = await readdir(path); this.current(); return files }
    catch (error) { if (absent(error)) return []; throw diskError(error) }
  }
  async write(relative: string, bytes: Buffer): Promise<void> {
    await this.ready(); this.current()
    if (bytes.length > MAX_BYTES) throw new VaultError('STORAGE_FAILED')
    const path = this.path(relative), temporary = path + '.' + randomUUID() + '.tmp'
    try {
      await this.directory(dirname(path), true)
      // Refuse an existing alias before replacing it. The boundary remains the independent Agent exclusion.
      const existing = await this.read(relative)
      existing?.fill(0)
      this.beforeWrite()
      const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
      try { this.beforeWrite(); await file.writeFile(bytes); this.current(); await file.sync(); this.current() } finally { await file.close() }
      this.current()
      await this.ready(); this.current()
      await this.directory(dirname(path), false)
      this.beforeWrite()
      await rename(temporary, path)
      this.current()
      const directory = await open(dirname(path), constants.O_RDONLY)
      try { this.current(); await directory.sync(); this.current() } finally { await directory.close() }
      this.current()
    } catch (error) { throw diskError(error) }
    finally { await unlink(temporary).catch(error => { if (!absent(error)) throw new VaultError('STORAGE_FAILED') }) }
  }
  async remove(relative: string): Promise<void> {
    await this.ready(); this.current()
    const bytes = await this.read(relative)
    if (!bytes) return
    bytes.fill(0)
    try {
      this.beforeWrite(); await unlink(this.path(relative)); this.current()
      const directory = await open(dirname(this.path(relative)), constants.O_RDONLY)
      try { this.current(); await directory.sync(); this.current() } finally { await directory.close() }
      this.current()
    } catch (error) { throw diskError(error) }
  }
}
