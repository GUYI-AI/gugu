import { replica } from '@/lib/replica';
import { rpcOn } from '@renderer/lib/ipc';
import { translateSessionMessage } from '@renderer/localization/locale-store';

/** A machine of the account: `'local'` = this computer (the session host it runs), otherwise its device id. */
type MachineArg = string;
const machineOf = (machine: MachineArg): string | null => (machine === 'local' ? null : machine);

/**
 * A machine's home folder (where the folder tree starts, what `~/` stands for). It does not change while the machine
 * runs: read once per account, never pushed, not kept across restarts.
 */
export const homeDirectory = replica({
  name: 'homeDirectory',
  scope: 'account',
  networkMode: 'always',
  read: async (_owner, machine: MachineArg): Promise<string> => {
    const home = await rpcOn(machineOf(machine)).app.getHomeDirectory();
    if (!home) throw new Error(translateSessionMessage('projects.dirTree.homeUnavailable'));
    return home;
  },
  fresh: Infinity,
});

/** What a folder on a machine is (a directory, a git repository): read each time it is chosen, held a minute. */
export const projectPathInspection = replica({
  name: 'projectPathInspection',
  scope: 'account',
  networkMode: 'always',
  read: (_owner, machine: MachineArg, path: string) =>
    rpcOn(machineOf(machine)).projects.inspectProjectPath({ type: 'local', path }),
  fresh: 0,
  keep: 60_000,
});
