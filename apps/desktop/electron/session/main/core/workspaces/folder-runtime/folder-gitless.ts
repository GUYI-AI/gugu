import { isFileNotFoundError, type IFileSystem } from '@gugu/session-core/files'
import type { RuntimePath } from '@main/core/runtime/types'
import type { Folder } from '@main/core/folders/folders'

/** A git folder points at its repository root, not an ancestor repo. */
export async function resolveFolderGitless(
  folder: Pick<Folder, 'path' | 'gitless'>,
  files: Pick<IFileSystem, 'stat'>,
  paths: Pick<RuntimePath, 'join'>
): Promise<boolean> {
  if (folder.gitless) return true
  return directoryHasNoGit(folder.path, paths.join(folder.path, '.git'), files)
}

export async function directoryHasNoGit(
  directoryPath: string,
  metadataPath: string,
  files: Pick<IFileSystem, 'stat'>
): Promise<boolean> {
  const metadata = await files.stat(metadataPath)
  // A .git file is valid for linked worktrees. Existing but damaged metadata
  // still goes through Git and reports its error instead of silently degrading.
  if (metadata.success) return false
  if (!isFileNotFoundError(metadata.error)) throw new Error(metadata.error.message)

  const directory = await files.stat(directoryPath)
  if (!directory.success) throw new Error(directory.error.message)
  if (directory.data.type !== 'directory') {
    throw new Error(`Folder path is not a directory: ${directoryPath}`)
  }
  return true
}
