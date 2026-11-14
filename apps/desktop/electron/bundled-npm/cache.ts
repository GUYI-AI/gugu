import { createHash } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import JSZip from 'jszip'
import { resolveGuguHome, retryWindowsFileLock } from '@gugu/core/local/state/paths'
import {
  ARCHIVE_NAME,
  MANIFEST_NAME,
  parseBundleManifest,
  type NpmBundleManifest
} from './format.cjs'

const preparations = new Map<string, Promise<string | null>>()
const MARKER = '.gugu-npm-complete.json'
const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')
const isMissing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'ENOENT'

async function readManifest(bundleRoot: string): Promise<NpmBundleManifest | null> {
  let bytes: string
  try {
    bytes = await readFile(join(bundleRoot, MANIFEST_NAME), 'utf8')
  } catch (error) {
    if (isMissing(error)) return null // Development/server and non-Windows packages retain their loose npm.
    throw error
  }
  return parseBundleManifest(JSON.parse(bytes) as unknown)
}

async function eachFile<T>(entries: T[], operation: (entry: T) => Promise<void>): Promise<void> {
  // Bound open handles while keeping all filesystem work off the Electron main thread.
  let next = 0
  let failed = false
  const results = await Promise.allSettled(
    Array.from({ length: Math.min(8, entries.length) }, async () => {
      while (!failed && next < entries.length) {
        try {
          await operation(entries[next++])
        } catch (error) {
          failed = true
          throw error
        }
      }
    })
  )
  const failure = results.find((result) => result.status === 'rejected')
  if (failure?.status === 'rejected') throw failure.reason
}

async function verifyFiles(root: string, manifest: NpmBundleManifest): Promise<void> {
  await eachFile(manifest.files, async (file) => {
    const location = join(root, ...file.path.split('/'))
    const info = await lstat(location)
    if (
      !info.isFile() ||
      info.size !== file.size ||
      hash(await readFile(location)) !== file.sha256
    ) {
      throw new Error(`[bundled-npm] Cached npm file failed verification: ${file.path}`)
    }
  })
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as {
    version?: unknown
    bundleDependencies?: unknown
    bundledDependencies?: unknown
  }
  const bundled = pkg.bundleDependencies ?? pkg.bundledDependencies ?? []
  if (
    pkg.version !== manifest.version ||
    !Array.isArray(bundled) ||
    JSON.stringify([...bundled].sort()) !== JSON.stringify([...manifest.bundledDependencies].sort())
  ) {
    throw new Error('[bundled-npm] npm package metadata does not match its manifest')
  }
}

async function verifiedCache(root: string, manifest: NpmBundleManifest): Promise<boolean> {
  let marker: { sha256?: unknown; version?: unknown }
  try {
    marker = JSON.parse(await readFile(join(root, MARKER), 'utf8')) as typeof marker
  } catch (error) {
    if (isMissing(error)) {
      try {
        await lstat(root)
      } catch (missing) {
        if (isMissing(missing)) return false
        throw missing
      }
      throw new Error(`[bundled-npm] Incomplete npm cache: ${root}`)
    }
    throw error
  }
  if (marker.sha256 !== manifest.sha256 || marker.version !== manifest.version) {
    throw new Error(`[bundled-npm] npm cache identity mismatch: ${root}`)
  }
  await verifyFiles(root, manifest)
  return true
}

async function prepare(appRoot: string, cacheBase: string): Promise<string | null> {
  const bundleRoot = join(appRoot, '..', 'npm-bundle')
  const manifest = await readManifest(bundleRoot)
  if (!manifest) return null
  const archive = await readFile(join(bundleRoot, ARCHIVE_NAME))
  if (hash(archive) !== manifest.sha256)
    throw new Error('[bundled-npm] Offline npm archive checksum mismatch')
  const cache = join(cacheBase, `${manifest.version}-${manifest.sha256}`)
  const cli = join(cache, 'bin', 'npm-cli.js')
  if (await verifiedCache(cache, manifest)) return cli
  const zip = await JSZip.loadAsync(archive)
  const entries = Object.values(zip.files).filter((entry) => !entry.dir)
  if (
    entries.length !== manifest.files.length ||
    entries.some(
      (entry) => entry.unsafeOriginalName !== undefined && entry.unsafeOriginalName !== entry.name
    )
  ) {
    throw new Error('[bundled-npm] Unexpected or unsafe npm archive entries')
  }
  const declared = new Set(manifest.files.map((file) => file.path))
  if (
    entries.some(
      (entry) =>
        !declared.has(entry.name) ||
        (typeof entry.unixPermissions === 'number' &&
          (entry.unixPermissions & 0o170000) === 0o120000)
    )
  ) {
    throw new Error('[bundled-npm] Undeclared npm archive entry or symbolic link')
  }
  await mkdir(cacheBase, { recursive: true, mode: 0o700 })
  const staging = await mkdtemp(join(cacheBase, '.npm-staging-'))
  try {
    await eachFile(manifest.files, async (file) => {
      const data = await zip.file(file.path)?.async('nodebuffer')
      if (!data || data.length !== file.size || hash(data) !== file.sha256) {
        throw new Error(`[bundled-npm] npm archive file failed verification: ${file.path}`)
      }
      const destination = join(staging, ...file.path.split('/'))
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
      await writeFile(destination, data, { mode: file.mode })
    })
    await verifyFiles(staging, manifest)
    await writeFile(
      join(staging, MARKER),
      JSON.stringify({ sha256: manifest.sha256, version: manifest.version }),
      { mode: 0o600 }
    )
    try {
      await retryWindowsFileLock(() => rename(staging, cache))
    } catch (error) {
      // Other processes may share a home. Publish only whole immutable directories, without a disk
      // lock that could outlive its owner. A valid winner is reusable; other failures stay errors.
      if (!(await verifiedCache(cache, manifest))) throw error
    }
    return cli
  } finally {
    await retryWindowsFileLock(() => rm(staging, { recursive: true, force: true }))
  }
}

/** Coalesce concurrent requests in the single main process; cross-process publication uses rename. */
export function prepareBundledNpm(appRoot: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  const cacheBase = join(resolveGuguHome(env), 'cache', 'bundled-npm')
  const key = `${resolve(appRoot)}\0${resolve(cacheBase)}`
  const existing = preparations.get(key)
  if (existing) return existing
  const pending = prepare(appRoot, cacheBase).finally(() => {
    if (preparations.get(key) === pending) preparations.delete(key)
  })
  preparations.set(key, pending)
  return pending
}
