import { replica } from '@/lib/replica';
import { rpcOn } from '@renderer/lib/ipc';
import { translateSessionMessage } from '@renderer/localization/locale-store';

/** This computer's home folder (the session host it runs): it does not change while the host runs. */
export const homeDirectory = replica({
  name: 'homeDirectory',
  scope: 'account',
  networkMode: 'always',
  read: async (): Promise<string> => {
    const home = await rpcOn(null).app.getHomeDirectory();
    if (!home) throw new Error(translateSessionMessage('projects.dirTree.homeUnavailable'));
    return home;
  },
  fresh: Infinity,
});

/** What a path on this computer is (a folder, a git repository) for a new project. */
export const projectPathInspection = replica({
  name: 'projectPathInspection',
  scope: 'account',
  networkMode: 'always',
  read: (_owner, path: string) => rpcOn(null).projects.inspectProjectPath({ type: 'local', path }),
  keep: 60_000,
});
