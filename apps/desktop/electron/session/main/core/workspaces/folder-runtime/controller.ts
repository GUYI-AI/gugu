import { ok } from '@gugu/session-shared';
import { createRPCController } from '@shared/lib/ipc/rpc';
import { openFolder as openFolderRuntime } from './folder-runtimes';
import { acquireFolderWorkspace, acquireTaskDirectory, releaseFolderWorkspace } from './workspace-lease';
import { countFoldersUsingGithubAccount } from './settings/count-folders-using-github-account';
import { folderSettingsService } from './settings/folder-settings-service';

/** A folder's runtime on this device: open it, and hold the draft workspace of the new-session page. */
export const folderRuntimeController = createRPCController({
  openFolder: async (folderId: string) => {
    const opened = await openFolderRuntime(folderId);
    if (!opened.success) return opened;
    // Whether the folder has Git is read from disk now (@@@disk-decides-git), not taken from its record.
    return ok({ gitless: !(await opened.data.git.open()) });
  },
  acquireFolderWorkspace,
  acquireTaskDirectory,
  releaseFolderWorkspace,
});

/** A folder's settings (repository-root settings, keyed by the folder id). */
export const folderSettingsController = createRPCController({
  getSettingsPage: (folderId: string) => folderSettingsService.getSettingsPage(folderId),
  updateSettings: (folderId: string, settings: Parameters<typeof folderSettingsService.updateSettings>[1]) =>
    folderSettingsService.updateSettings(folderId, settings),
  patchSettings: (folderId: string, patch: Parameters<typeof folderSettingsService.patchSettings>[1]) =>
    folderSettingsService.patchSettings(folderId, patch),
  shareSettingsToConfig: (folderId: string, request: Parameters<typeof folderSettingsService.shareSettingsToConfig>[1]) =>
    folderSettingsService.shareSettingsToConfig(folderId, request),
  countFoldersUsingGithubAccount,
});
