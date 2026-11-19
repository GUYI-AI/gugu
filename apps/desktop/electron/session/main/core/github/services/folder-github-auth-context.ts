import type { Result } from '@gugu/session-shared';
import type { GitHubApiAuthContext } from '@main/core/github/services/github-api-auth-service';
import { openFolder } from '@main/core/workspaces/folder-runtime/folder-runtimes';
import { log } from '@main/lib/logger';
import {
  FolderGitHubAuthContextResolver,
  type FolderGitHubAuthContextError,
} from './folder-github-auth-context-resolver';

export type { FolderGitHubAuthContextError } from './folder-github-auth-context-resolver';

const folderGitHubAuthContextResolver = new FolderGitHubAuthContextResolver({
  openFolder: async (folderId) => {
    const opened = await openFolder(folderId);
    return opened.success ? opened.data : undefined;
  },
  logger: log,
});

export function resolveFolderGitHubAuthContext(
  folderId: string
): Promise<Result<GitHubApiAuthContext, FolderGitHubAuthContextError>> {
  return folderGitHubAuthContextResolver.resolve(folderId);
}
