import path from 'node:path';
import { canonicalPath, inWorkingCopy, placeUnder, type CanonicalPath, type FileError } from '@gugu/session-core/files';
import { err, ok, type Result } from '@gugu/session-shared';

export type WorkspacePathResolution = {
  path: CanonicalPath;
};

/**
 * A path the file panel names (absolute, or relative to the working copy) → its canonical path, only when it is in the
 * working copy (`@@@working-copy-containment`: by name, and a link there that leads out is not).
 */
export function resolveWorkspacePath(
  workspacePath: CanonicalPath,
  filePath: string,
  options: { allowEmpty?: boolean } = {}
): Result<WorkspacePathResolution, FileError> {
  let absPath: string;
  if (path.isAbsolute(filePath)) {
    absPath = filePath;
  } else {
    const relativePath = normalizeRelativePath(filePath, options);
    if (!relativePath.success) return relativePath;
    absPath = path.join(workspacePath, relativePath.data);
  }
  const canonical = canonicalPath(absPath);
  if (inWorkingCopy(workspacePath, canonical) === null) {
    return err({
      type: 'invalid-path',
      path: filePath,
      message: 'Path must be inside the workspace',
    });
  }
  return ok({ path: canonical });
}

export async function assertWorkspaceWriteAllowed(
  workspacePath: CanonicalPath,
  filePath: string
): Promise<Result<WorkspacePathResolution, FileError>> {
  return resolveWorkspacePath(workspacePath, filePath);
}

/** Removing or renaming takes the entry itself (a link, not where it leads): its folder must be in the working copy. */
export async function assertWorkspaceRemoveAllowed(
  workspacePath: CanonicalPath,
  filePath: string
): Promise<Result<WorkspacePathResolution, FileError>> {
  const absolute = path.isAbsolute(filePath) ? filePath : path.join(workspacePath, filePath);
  const folder = resolveWorkspacePath(workspacePath, path.dirname(absolute), { allowEmpty: true });
  if (!folder.success) return pathEscapeError(filePath);
  const entry = canonicalPath(absolute, { entry: true });
  // By name: removing a link that leads out takes only the link.
  if (entry === workspacePath || placeUnder(folder.data.path, entry) === null) return pathEscapeError(filePath);
  return ok({ path: entry });
}

export async function assertWorkspaceDirectoryTargetAllowed(
  workspacePath: CanonicalPath,
  dirPath: string
): Promise<Result<WorkspacePathResolution, FileError>> {
  return resolveWorkspacePath(workspacePath, dirPath, { allowEmpty: true });
}

function normalizeRelativePath(
  filePath: string,
  options: { allowEmpty?: boolean }
): Result<string, FileError> {
  if (filePath.includes('\0')) return invalidPathError(filePath, 'Path contains a null byte');
  const normalized = path.posix.normalize(filePath.replace(/\\/g, '/'));
  if (normalized === '.') {
    if (options.allowEmpty) return ok('');
    return invalidPathError(filePath, 'Path must not be empty');
  }
  if (path.posix.isAbsolute(normalized) || path.win32.isAbsolute(normalized)) {
    return invalidPathError(filePath, 'Path must be relative');
  }
  const parts = normalized.split('/').filter(Boolean);
  if (parts.includes('..'))
    return invalidPathError(filePath, 'Parent path segments are not allowed');
  return ok(parts.join('/'));
}

function pathEscapeError(inputPath: string): Result<never, FileError> {
  return invalidPathError(inputPath, 'Path resolves outside the workspace');
}

function invalidPathError(inputPath: string, message: string): Result<never, FileError> {
  return err({
    type: 'invalid-path',
    path: inputPath,
    message,
  });
}
