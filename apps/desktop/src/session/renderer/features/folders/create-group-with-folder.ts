import { machineLinkState } from '@renderer/lib/machine-clients';
import { rpcOn } from '@renderer/lib/ipc';
import { carryRunMachine } from '@renderer/features/projects/components/main-panel/project-run-machine';
import { rememberFolderChoice } from './group-folders';
import { groupFoldersStore } from './group-folders-store';

/** The machine is not connected: nothing can be bound there now (the dialog says so, ❌ binding later). */
export class FolderMachineOfflineError extends Error {
  constructor(readonly deviceId: string) {
    super(`machine ${deviceId} is not connected`);
    this.name = 'FolderMachineOfflineError';
  }
}

/**
 * 「新建群（同时新建一个文件夹）」/「用现有文件夹新建群」: the group is created first (online), then the folder at `path` on
 * `machine` (null = this computer) is bound to it — `create` makes the directory there first. A machine that is not
 * connected is refused before the group is made (❌「bind first, make the group later」). Returns the new group's chat id.
 * The folder is what a new task in that group starts in.
 */
export async function createGroupWithFolder({ name, machine, path, create = false }: {
  name: string;
  machine: string | null;
  path: string;
  create?: boolean;
}): Promise<string> {
  if (machine && machineLinkState(machine) !== 'open') throw new FolderMachineOfflineError(machine);
  // Loaded when used: importing the cloud client with this module would create it wherever the group page is imported.
  const [{ chatService }, { getCurrentAuthUserId }] = await Promise.all([import('@/lib/chat'), import('@/lib/supabase')]);
  const created = await chatService.createGroupChat(name, await getCurrentAuthUserId(), []);
  const bound = await rpcOn(machine).folders.bindFolderAtPath({ path, chatId: created.chat_id, create });
  // The group exists either way; a folder that could not be bound is said loudly (the group page's「+」binds one).
  if (!bound.success) throw new Error(bound.error.type, { cause: bound.error });
  void groupFoldersStore.readMachine(machine);
  rememberFolderChoice(created.chat_id, bound.data.id);
  carryRunMachine(created.chat_id, machine);
  return created.chat_id;
}
