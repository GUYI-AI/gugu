import { providerAccountRegistry } from '@main/core/provider-accounts/provider-account-registry-instance';
import { FolderGitHubAccountBackfillService } from './folder-github-account-backfill';

export const folderGitHubAccountBackfillService = new FolderGitHubAccountBackfillService(
  providerAccountRegistry
);
