// @@@group-folders — a group is the only container; a folder on this device is an optional attribute of a group.
//
// A folder is a `workspaces` row of kind 'project-root' (a repository root or any directory a person picked), keyed by
// its canonical path. It carries the group it is bound to (`chat_id`, null = no group), its order among that group's
// folders on this device (`sort`), and whether it is a git repository (`gitless`, `base_ref`). Worktrees and attached
// paths of earlier releases are folders too. Sessions record their group (`sessions.chat_id`) and their cwd
// (`sessions.workspace_id`) themselves; nothing here knows sessions.
//
// Not here: creating groups (a group exists before a folder is bound to it), publishing to the account (folder-publish),
// and the ids of earlier releases' local projects (legacy-project-aliases).
import { randomUUID } from 'node:crypto';
import { and, asc, eq, isNull, max } from 'drizzle-orm';
import { computeWorkspaceKey } from '@main/core/workspaces/workspace-key';
import { db, type AppDb, type DrizzleTx } from '@main/db/client';
import { workspaces } from '@main/db/schema';
import type { CanonicalPath } from '@gugu/session-shared/canonical-path';

export type Folder = {
  /** The workspace id: the folder's id on this device and the key file versions held in it carry. */
  id: string;
  path: CanonicalPath;
  /** The group the folder is bound to here; null = a folder without a group. */
  chatId: string | null;
  /** Position among the group's folders on this device (1 = where a new task starts by default). */
  sort: number | null;
  gitless: boolean;
  /** The git base branch; null = 'main' for a git folder, unused for a gitless one. */
  baseRef: string | null;
  attachedAt: string | null;
};

type Runner = AppDb | DrizzleTx;

const COLUMNS = {
  id: workspaces.id,
  path: workspaces.path,
  chatId: workspaces.chatId,
  sort: workspaces.sort,
  gitless: workspaces.gitless,
  baseRef: workspaces.baseRef,
  attachedAt: workspaces.attachedAt,
};

function toFolder(row: { id: string; path: CanonicalPath | null; chatId: string | null; sort: number | null;
  gitless: boolean; baseRef: string | null; attachedAt: string | null }): Folder {
  if (!row.path) throw new Error(`folder ${row.id} has no path`);
  return { ...row, path: row.path };
}

/** A group's folders on this device in order, or every folder bound to a group when no chat is named. */
export function listFolders(chatId?: string, runner: Runner = db): Folder[] {
  const bound = chatId === undefined ? undefined : eq(workspaces.chatId, chatId);
  return runner.select(COLUMNS).from(workspaces)
    .where(and(eq(workspaces.kind, 'project-root'), bound))
    .orderBy(asc(workspaces.chatId), asc(workspaces.sort), asc(workspaces.id))
    .all()
    .filter((row) => chatId !== undefined || row.chatId !== null)
    .map(toFolder);
}

export function getFolder(id: string, runner: Runner = db): Folder | undefined {
  const [row] = runner.select(COLUMNS).from(workspaces).where(eq(workspaces.id, id)).limit(1).all();
  return row ? toFolder(row) : undefined;
}

export function folderAtPath(path: CanonicalPath, runner: Runner = db): Folder | undefined {
  const [row] = runner.select(COLUMNS).from(workspaces)
    .where(and(eq(workspaces.key, computeWorkspaceKey(path)), eq(workspaces.kind, 'project-root')))
    .limit(1).all();
  return row ? toFolder(row) : undefined;
}

/**
 * The folder at this path, created when the device has none (without a group). `id` reuses an id other records
 * already point at (a repaired row keeps the id sessions name).
 */
export function ensureFolder(path: CanonicalPath, options: { id?: string; gitless?: boolean; baseRef?: string | null } = {},
  runner: Runner = db): Folder {
  const existing = folderAtPath(path, runner);
  if (existing) return existing;
  const id = options.id ?? randomUUID();
  runner.insert(workspaces).values({
    id, kind: 'project-root', location: 'local', sshConnectionId: null, type: 'local', path, key: computeWorkspaceKey(path),
    gitless: options.gitless ?? false, baseRef: options.baseRef ?? null,
  }).run();
  const created = getFolder(id, runner);
  if (!created) throw new Error(`folder ${path} was not recorded`);
  return created;
}

/**
 * Bind a folder to a group (appended last among that group's folders here), move it to another group, or unbind it
 * (chatId null). Sessions keep the group they were started in. Returns whether anything changed.
 */
export function bindFolder(id: string, chatId: string | null, runner: Runner = db): boolean {
  const folder = getFolder(id, runner);
  if (!folder) throw new Error(`folder ${id} not found`);
  if (folder.chatId === chatId) return false;
  const [last] = chatId === null ? [] : runner.select({ sort: max(workspaces.sort) }).from(workspaces)
    .where(eq(workspaces.chatId, chatId)).all();
  runner.update(workspaces).set({
    chatId,
    sort: chatId === null ? null : (last?.sort ?? 0) + 1,
    attachedAt: chatId === null ? null : new Date().toISOString(),
  }).where(eq(workspaces.id, id)).run();
  return true;
}

/** Put a group's folders on this device in this order (ids not bound to the group are refused). */
export function reorderFolders(chatId: string, ids: readonly string[], runner: Runner = db): void {
  const bound = new Set(listFolders(chatId, runner).map((folder) => folder.id));
  for (const id of ids) if (!bound.has(id)) throw new Error(`folder ${id} is not bound to ${chatId}`);
  ids.forEach((id, index) => runner.update(workspaces).set({ sort: index + 1 }).where(eq(workspaces.id, id)).run());
}

/** Folders the device keeps without a group (the task home, an App's own directory, a cloud computer's directory). */
export function listUnboundFolders(runner: Runner = db): Folder[] {
  return runner.select(COLUMNS).from(workspaces)
    .where(and(eq(workspaces.kind, 'project-root'), isNull(workspaces.chatId))).all().map(toFolder);
}
