import { err, ok, type Result } from '@gugu/session-shared';
import type { GitHubApiAuthContext } from '@main/core/github/services/github-api-auth-service';
import type { FolderSettingsProvider } from '@main/core/workspaces/folder-runtime/settings/provider';

export type FolderGitHubAuthContextError =
  | {
      type: 'folder_not_found';
      folderId: string;
      message: string;
    }
  | {
      type: 'unconfigured';
      folderId: string;
      message: string;
    }
  | {
      type: 'disabled';
      folderId: string;
      message: string;
    }
  | {
      type: 'account_selection_failed';
      folderId: string;
      message: string;
    };

type FolderGitHubAuthContextFolder = {
  settings: Pick<FolderSettingsProvider, 'get'>;
};

type FolderLookup = (folderId: string) => Promise<FolderGitHubAuthContextFolder | undefined>;

type WarningLogger = {
  warn(message: string, context: Record<string, unknown>): void;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class FolderGitHubAuthContextResolver {
  constructor(
    private readonly deps: {
      openFolder: FolderLookup;
      logger: WarningLogger;
    }
  ) {}

  async resolve(
    folderId: string
  ): Promise<Result<GitHubApiAuthContext, FolderGitHubAuthContextError>> {
    const folder = await this.deps.openFolder(folderId);
    if (!folder) {
      return err({
        type: 'folder_not_found',
        folderId,
        message: `Folder ${folderId} could not be opened.`,
      });
    }

    try {
      const settings = await folder.settings.get();
      if (!Object.hasOwn(settings, 'githubAccountId')) {
        return err({
          type: 'unconfigured',
          folderId,
          message: 'No GitHub account is configured for this folder.',
        });
      }

      if (settings.githubAccountId === null) {
        return err({
          type: 'disabled',
          folderId,
          message: 'GitHub API is disabled for this folder.',
        });
      }

      const accountId = settings.githubAccountId?.trim() || null;
      if (!accountId) {
        return err({
          type: 'unconfigured',
          folderId,
          message: 'No GitHub account is configured for this folder.',
        });
      }
      return ok({ accountId });
    } catch (error) {
      const message = errorMessage(error);
      this.deps.logger.warn('Failed to resolve folder GitHub account selection', {
        folderId,
        error: message,
      });
      return err({
        type: 'account_selection_failed',
        folderId,
        message,
      });
    }
  }
}
