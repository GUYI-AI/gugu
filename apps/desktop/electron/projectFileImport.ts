import { requireAgentFileAccess, requireAgentFileTreeAccess } from '@gugu/core/local/state/agentFileBoundary'
import { createReadStream, constants } from 'node:fs'
import { copyFile, mkdir, readdir, rm, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { promisify } from 'node:util'
import { execFile } from '@gugu/core/local/childProcess'
import { coreLogger } from '@gugu/core/log'
import { etagOf, inWorkspace } from './session/main/core/files/workspace-transfer'
import { sanitizeRemoteFileName } from './remoteFileOpen'

const clone = promisify(execFile)
async function copySnapshot(source: string, target: string) {
  source = await requireAgentFileAccess(source)
  target = await requireAgentFileAccess(target)
  if (process.platform === 'darwin') {
    try { await clone('/bin/cp', ['-c', '-n', source, target]); return }
    catch (error) {
      const failure = error as { code?: string | number; stderr?: string }
      if (failure.code !== 1) throw error
      // cp cannot distinguish unsupported cloning from ordinary I/O errors. The exclusive copy below still throws
      // for missing/unreadable sources or a full disk; it succeeds when only cloning was unavailable.
      coreLogger('project-file-import').warn({ err: error, stderr: failure.stderr }, 'Could not clone version snapshot; copying the file')
      await rm(target, { force: true })
    }
  }
  // Node's FICLONE silently copies on macOS; use cp above for APFS clones. Other platforms keep the existing behavior.
  await copyFile(source, target, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE)
}

const digest = async (file: string) => {
  const hash = createHash('sha256')
  for await (const bytes of createReadStream(await requireAgentFileAccess(file))) hash.update(bytes)
  return hash.digest('hex')
}
/**
 * Every send is a project-owned copy, so a version's bytes never change when its original is edited. Copies are kept by
 * content (`.gugu/attachments/<sha256>/<name>`): an earlier send of the same bytes, or an attempt whose publication
 * failed, is found there and reused after re-verification.
 */
export async function importProjectFile(root: string, file: { path: string; name: string; size: number }) {
  await requireAgentFileTreeAccess(root)
  file = { ...file, path: await requireAgentFileAccess(file.path) }
  const before = await stat(file.path, { bigint: true })
  if (!before.isFile() || Number(before.size) !== file.size) throw new Error('Selected file changed')
  const unchanged = async () => { if (etagOf(await stat(file.path, { bigint: true })) !== etagOf(before)) throw new Error('Selected file changed') }
  const sha = await digest(file.path)
  await unchanged()
  const directory = `.gugu/attachments/${sha}`
  const kept = await readdir(await inWorkspace(root, directory)).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return []; throw error })
  for (const name of kept) {
    const path = await inWorkspace(root, `${directory}/${name}`)
    if ((await stat(path)).size === file.size && await digest(path) === sha) { await unchanged(); return path }
    await rm(path, { force: true }) // No longer these bytes, so no version can read it as them.
  }
  // Create and re-check each level: an existing .gugu or attachments symlink cannot escape the root.
  for (const path of ['.gugu', '.gugu/attachments']) await mkdir(await inWorkspace(root, path), { recursive: true, mode: 0o700 })
  const created = await mkdir(await inWorkspace(root, directory), { recursive: true, mode: 0o700 })
  const target = await inWorkspace(root, `${directory}/${sanitizeRemoteFileName(file.name)}`)
  try {
    // Keep the version separate from the agent's editable original, using a clone where the filesystem supports it.
    await copySnapshot(file.path, target)
    await unchanged()
    if (await digest(target) !== sha) throw new Error('Imported file changed')
    return target
  } catch (error) {
    await rm(created ?? target, { recursive: true, force: true }) // Only what this import created, not yet published.
    throw error
  }
}
