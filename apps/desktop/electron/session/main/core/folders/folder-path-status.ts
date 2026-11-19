// What is at a path on this machine: a directory, a git repository, a file, or nothing (moved from the retired
// projects module's getLocalProjectPathStatus).
import { isFileNotFoundCode } from '@gugu/session-core/files';
import { statAbsolute } from '@main/core/runtime/files-helpers';
import { runtimeManager } from '@main/core/runtime/runtime-manager';
import type { FolderPathStatus } from '@shared/core/folders/folders';

export async function folderPathStatus(path: string): Promise<Omit<FolderPathStatus, 'existing'>> {
  const runtimeLease = await runtimeManager.acquire();
  try {
    const pathEntry = await statAbsolute(runtimeLease.value.files, path);
    if (!pathEntry.success) {
      const code = 'code' in pathEntry.error ? pathEntry.error.code : undefined;
      if (isFileNotFoundCode(code)) return { isDirectory: false, isGitRepo: false };
      return { isDirectory: false, isGitRepo: false, error: { type: 'inspect-failed', path, message: pathEntry.error.message } };
    }
    if (pathEntry.data.type !== 'directory') return { isDirectory: false, isGitRepo: false, isFile: true };
    const inspection = await runtimeLease.value.git.inspectPath(path);
    if (inspection.kind === 'inspect-failed') {
      return { isDirectory: true, isGitRepo: false, error: { type: 'inspect-failed', path: inspection.path, message: inspection.message } };
    }
    return { isDirectory: true, isGitRepo: inspection.kind === 'repository' };
  } finally {
    await runtimeLease.release();
  }
}
