import { rendererLogger } from '@/lib/log';
import { toast } from '@renderer/lib/hooks/use-toast';
import type { useSessionMessages } from '@renderer/localization/use-session-messages';
import { basenameFromAnyPath } from '@shared/path-name';
import { createGroupWithFolder, FolderMachineOfflineError } from './create-group-with-folder';

type Translate = ReturnType<typeof useSessionMessages>['translate'];

const log = rendererLogger('folders/create-group-from-folder');

/**
 * 「用现有文件夹新建群」: the group is named after the folder; the folder is bound as it is (no git init, any directory).
 * The menu (system dialog) and the web dialog (in-app directory tree) share this; null = not created.
 * The cause goes to the log; the toast only says what the person can do next.
 */
export async function createGroupFromFolder(path: string, translate: Translate, machine: string | null = null): Promise<string | null> {
  const name = basenameFromAnyPath(path);
  if (!name) {
    toast({
      title: translate('projects.create.folderUnusable'),
      description: translate('projects.create.folderNameUnreadable'),
      variant: 'destructive',
    });
    return null;
  }
  try {
    return await createGroupWithFolder({ name, machine, path });
  } catch (error) {
    log.error({ path, machine, error: error instanceof Error ? error.message : String(error) }, 'creating a group with an existing folder failed');
    toast({
      title: translate('projects.create.folderUnusable'),
      description: translate(error instanceof FolderMachineOfflineError ? 'projects.create.machineOffline' : 'projects.create.folderUnusableDetail'),
      variant: 'destructive',
    });
    return null;
  }
}
