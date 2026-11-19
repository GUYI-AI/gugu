// @@@group-folders — the folder record the main process and the renderer share. A folder is a directory on one machine,
// optionally bound to a group (chat). Owned by lane A of C1; the renderer reads it, never redefines it.
import { defineEvent } from '@shared/lib/ipc/events';

export type FolderRecord = {
  /** The folder's id on its machine (workspace id). */
  id: string;
  path: string;
  /** The group it is bound to there; null = none. */
  chatId: string | null;
  /** Position among the group's folders on that machine; 1 = where a new task starts by default. */
  sort: number | null;
  gitless: boolean;
  baseRef: string | null;
  attachedAt: string | null;
  /** Current git branch when known (null for gitless folders or before the first read). */
  branch: string | null;
  /** Sessions working in it right now that are not archived. */
  sessionIds: string[];
  /** The task home: where sessions without a group start (one per machine; its id differs per machine). */
  taskHome: boolean;
};

export type FolderPathStatus = {
  isDirectory: boolean;
  isGitRepo: boolean;
  isFile?: true;
  error?: { type: 'inspect-failed'; path: string; message: string };
  /** The folder already recorded at this path on this machine, if any (with the group it is bound to). */
  existing?: FolderRecord;
};

export type FolderError =
  | { type: 'not-a-directory'; path: string }
  | { type: 'inspect-failed'; path: string; message: string }
  | { type: 'folder-not-found'; id: string }
  | { type: 'bound-elsewhere'; id: string; chatId: string };

/** A machine's folders or their bindings changed; `chatIds` are the groups whose folder list changed there. */
export const foldersChangedChannel = defineEvent<{ chatIds: string[] }>('folders:changed');
