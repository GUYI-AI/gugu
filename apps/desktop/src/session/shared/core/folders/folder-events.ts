// Events of a folder's own runtime (settings, repository), keyed by the folder id. Owned by lane B of C1.
import { defineEvent } from '@shared/lib/ipc/events';

/** A folder's settings changed: re-read `folderSettings.getSettingsPage(folderId)`. */
export const folderSettingsChangedChannel = defineEvent<{
  folderId: string;
}>('folder:settings-changed');
