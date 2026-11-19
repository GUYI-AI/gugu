import { type FileError, type FileStat, type IFileSystem } from '@gugu/session-core/files';
import { err, type Result } from '@gugu/session-shared';
import type { IFilesRuntime } from './types';

export type AbsoluteDirectoryFileSystem = {
  mkdir(path: string, options?: { recursive?: boolean }): Promise<Result<void, FileError>>;
  realPath(path: string): Promise<Result<string, FileError>>;
};

export function openFileSystem(files: IFilesRuntime): Result<IFileSystem, FileError> {
  return files.fileSystem();
}

export async function ensureAbsoluteDir(
  files: IFilesRuntime,
  absPath: string,
  options: { recursive?: boolean } = {}
): Promise<Result<void, FileError>> {
  if (!files.path.isAbsolute(absPath)) {
    return err({
      type: 'invalid-path',
      path: absPath,
      message: `Expected absolute path: ${absPath}`,
    });
  }

  const opened = openFileSystem(files);
  if (!opened.success) return opened;
  return opened.data.mkdir(absPath, {
    recursive: options.recursive ?? true,
  });
}

export async function realPathAbsolute(
  files: IFilesRuntime,
  absPath: string
): Promise<Result<string, FileError>> {
  if (!files.path.isAbsolute(absPath)) {
    return err({
      type: 'invalid-path',
      path: absPath,
      message: `Expected absolute path: ${absPath}`,
    });
  }

  const opened = openFileSystem(files);
  if (!opened.success) return opened;
  return opened.data.realPath(absPath);
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
