import { type FileError, type FileStat, type IFileSystem } from '@gugu/session-core/files';
import { type Result } from '@gugu/session-shared';
import type { IFilesRuntime } from './types';

export function openFileSystem(files: IFilesRuntime): Result<IFileSystem, FileError> {
  return files.fileSystem();
}

export async function statAbsolute(
  files: IFilesRuntime,
  absPath: string
): Promise<{ success: true; data: FileStat } | { success: false; error: FileError }> {
  if (!files.path.isAbsolute(absPath)) {
    return {
      success: false,
      error: { type: 'invalid-path', path: absPath, message: `Expected absolute path: ${absPath}` },
    };
  }

  const opened = openFileSystem(files);
  if (!opened.success) return opened;
  return opened.data.stat(absPath);
}
