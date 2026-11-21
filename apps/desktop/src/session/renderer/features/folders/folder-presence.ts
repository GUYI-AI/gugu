import { remoteHostsStore } from '@renderer/features/remote-hosts/remote-hosts-store';
import { appState } from '@renderer/lib/stores/app-state';
import { machineOfAlias, machineRegistry } from '@renderer/lib/machine-routing';

/**
 * Whether a folder (a session's `projectId`) is there in this desktop's eyes — the same rule as the main process's
 * restored navigation (core/view-state `restoredSessionState`): only "known gone" is gone, ❌「not in the table now = deleted」.
 *  · present: in the table (this computer's, or a machine's read through its connection / the account's record).
 *  · unknown: not in the table, and the other machines' lists are not all here yet (at boot, before the session page and
 *    the machines are up). Every list that arrives runs the guards again (remote-hosts-store).
 *  · deleted: otherwise.
 *
 * Exception (#3425): every machine has a hidden task workspace (`<fixed id>~<machine>`) that no account record lists (#609).
 * While that machine is in the roster and its own list has not been read, its absence says nothing: unknown. Only once that
 * machine's own list is read without it (or the machine left the roster) is it deleted.
 */
export type FolderPresence = 'present' | 'unknown' | 'deleted';

export function folderPresence(folderId: string): FolderPresence {
  if (appState.projects.projects.has(folderId)) return 'present';
  if (remoteHostsStore.awaitsMachineLists()) return 'unknown';
  const machine = machineOfAlias(folderId, machineRegistry.fixedIds);
  if (machine && remoteHostsStore.device(machine) && !remoteHostsStore.hasReadList(machine)) return 'unknown';
  return 'deleted';
}
