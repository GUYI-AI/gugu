import { createHash } from 'node:crypto'
import { constants, promises as fs } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import type { ResolvedAgentHome } from '../capabilities/config-root'
import type { AgentHomeGroupId } from '../capabilities/session-bundle'

const disk: typeof fs = process.versions.electron
  ? createRequire(import.meta.url)('original-fs').promises
  : fs
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT'
export type AgentHomeSpace = {
  requiredBytes: number
  availableBytes: number
  shortfallBytes: number
}
export class AgentHomeSpaceError extends Error {
  readonly code = 'AGENT_HOME_INSUFFICIENT_SPACE'
  constructor(readonly space: AgentHomeSpace) {
    super('Insufficient disk space for configuration migration')
    this.name = 'AgentHomeSpaceError'
  }
}
export async function checkAgentHomeImportSpace(
  entries: readonly {
    home: ResolvedAgentHome
    groups: ReadonlySet<AgentHomeGroupId>
    historyPaths?: readonly string[]
  }[],
  options: { includeStaging?: boolean; includeCredentials?: boolean } = {}
): Promise<void> {
  if (!entries.length) return
  let bytes = 0
  const seen = new Set<string>()
  const size = async (path: string): Promise<void> => {
    if (seen.has(path)) return
    seen.add(path)
    const stat = await disk.lstat(path).catch((error: unknown) => {
      if (missing(error)) return null
      throw error
    })
    if (!stat) return
    if (stat.isDirectory())
      for (const name of await disk.readdir(path)) await size(resolve(path, name))
    else bytes += stat.size
  }
  for (const { home, groups, historyPaths = [] } of entries) {
    seen.clear();
    const root = await disk.realpath(home.userConfigRoot).catch((error: unknown) => {
      if (missing(error)) return home.userConfigRoot
      throw error
    })
    for (const group of home.importGroups.filter(({ id }) => groups.has(id)))
      for (const item of group.paths) {
        await size(resolve(root, typeof item === 'string' ? item : item.path))
      }
    for (const path of [...historyPaths, ...(options.includeCredentials === false ? [] : home.credentialPaths)]) await size(resolve(root, path))
    // Staging preserves the existing managed home using an ordinary copy as well.
    if (options.includeStaging !== false) await size(home.shadowHome)
  }
  let parent = dirname(entries[0]!.home.shadowHome)
  for (;;) {
    try {
      const stat = await disk.statfs(parent)
      const availableBytes = stat.bavail * stat.bsize
      const requiredBytes = bytes + Math.max(2 * 1024 ** 3, Math.ceil(bytes * 0.1))
      if (requiredBytes > availableBytes)
        throw new AgentHomeSpaceError({
          requiredBytes,
          availableBytes,
          shortfallBytes: requiredBytes - availableBytes
        })
      return
    } catch (error) {
      if (!missing(error) || dirname(parent) === parent) throw error
      parent = dirname(parent)
    }
  }
}
function inside(root: string, path: string): boolean {
  const part = relative(root, path)
  return part !== '..' && !part.startsWith('..' + sep) && !isAbsolute(part)
}
/** Copy the link, never the target. Relative links to unimported locations keep their original target. */
export async function importedLinkTarget(
  home: ResolvedAgentHome,
  source: string,
  included: readonly string[],
  sourceRoot = home.userConfigRoot
): Promise<string> {
  const raw = await disk.readlink(source)
  const target = resolve(dirname(source), raw)
  try {
    const real = await disk.realpath(source)
    const stat = await disk.stat(real)
    if (stat.isDirectory() && inside(real, dirname(source)))
      throw Object.assign(new Error('Cyclic symbolic link'), { code: 'ELOOP' })
  } catch (error) {
    if (!missing(error)) throw error
  }
  if (isAbsolute(raw)) return raw
  const rel = relative(sourceRoot, target).split(sep).join('/')
  const copied =
    inside(sourceRoot, source) && inside(sourceRoot, target) &&
    included.some((item) => rel === item || rel.startsWith(item.replace(/\/$/, '') + '/'))
  return copied ? raw : target
}
/** Bounded reads, including for large skill assets; compare the opened inode and content again when copying. */
export async function streamImportFile(
  source: string,
  destination?: string,
  expected?: string,
  root = dirname(source),
  onDestinationOpened?: (identity: { ino: number; dev: number }) => Promise<void>
): Promise<string> {
  const checkParents = async () => {
    if (!inside(root, source)) throw new Error('Import source escapes its root');
    let current = root;
    for (const part of ['', ...relative(root, dirname(source)).split(sep).filter(Boolean)]) {
      if (part) current = resolve(current, part);
      if ((await disk.lstat(current)).isSymbolicLink()) throw Object.assign(new Error('Source directory changed to a link'), { code: 'ESTALE' });
    }
  };
  await checkParents();
  const before = await disk.lstat(source)
  const input = await disk.open(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  let output: Awaited<ReturnType<typeof disk.open>> | undefined
  try {
    const opened = await input.stat()
    if (!opened.isFile() || opened.ino !== before.ino || opened.dev !== before.dev)
      throw Object.assign(new Error('Source changed'), { code: 'ESTALE' })
    if (destination) {
      output = await disk.open(destination, 'wx', before.mode & 0o777)
      const { ino, dev } = await output.stat()
      await onDestinationOpened?.({ ino, dev })
    }
    const hash = createHash('sha256'),
      buffer = Buffer.alloc(64 * 1024)
    let total = 0
    for (;;) {
      const { bytesRead } = await input.read(buffer, 0, buffer.length, null)
      if (!bytesRead) break
      total += bytesRead
      hash.update(buffer.subarray(0, bytesRead))
      if (output)
        for (let written = 0; written < bytesRead; )
          written += (await output.write(buffer, written, bytesRead - written, null)).bytesWritten
    }
    await checkParents();
    const after = await input.stat(),
      current = await disk.lstat(source),
      digest = hash.digest('hex')
    if (
      total !== before.size ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      current.ino !== before.ino ||
      current.dev !== before.dev ||
      current.mtimeMs !== before.mtimeMs ||
      (expected && digest !== expected)
    ) {
      throw Object.assign(new Error('Source changed'), { code: 'ESTALE' })
    }
    return digest
  } finally {
    await output?.close()
    await input.close()
  }
}
