import { basename, isAbsolute, resolve } from 'node:path';
import { canonicalPath } from '@gugu/session-core/files';
import { gitErrorMessage, isNotRepositoryInspectionError } from '@gugu/session-core/git';
import { and, eq } from 'drizzle-orm';
import { TRANSCRIPT_SOURCE_IDS, type TranscriptSource } from '@gugu/core/shared/types/transcripts';
import { db } from '@main/db/client';
import { workspaceRemotes, workspaces } from '@main/db/schema';
import { listFolders, listUnboundFolders } from '@main/core/folders/folders';
import { getLocalSessionSource } from '@main/core/session-import/host-source';
import { createLocalGroupOf } from '@main/core/session-history/local-session-group';
import { findRepoRoot } from '@main/core/session-history/repo-root';
import { folderNamed } from './app-files';
import { parseRepositoryRef } from '@shared/repository-ref';
import { sessionPageNumber, type AppSessionGroup, type AppSessionIndex } from '@shared/extensions/app-sessions';

const invalid = (message: string): never => { throw Object.assign(new Error(message), { code: 'invalid' }); };
function sourceOf(value: unknown): TranscriptSource | undefined {
  if (value === undefined) return undefined;
  if (!TRANSCRIPT_SOURCE_IDS.includes(value as TranscriptSource)) return invalid(`source is ${TRANSCRIPT_SOURCE_IDS.join(' or ')}`);
  return value as TranscriptSource;
}

export async function indexSessionsForApp(args: Record<string, unknown>): Promise<AppSessionIndex> {
  const source = sourceOf(args.source);
  const offset = sessionPageNumber(args.offset, 'offset', 0);
  const limit = sessionPageNumber(args.limit, 'limit', 100);
  if (args.groupPaths !== undefined && (!Array.isArray(args.groupPaths)
    || !args.groupPaths.every((path) => typeof path === 'string' && isAbsolute(path)))) {
    return invalid('groupPaths is an array of absolute directories');
  }
  const groupPaths = (args.groupPaths as string[] | undefined) ?? [];
  let cwd: string | undefined;
  if (args.project !== undefined) {
    // `project` names a folder (the App protocol's name until S2) or an absolute directory.
    if (typeof args.project !== 'string' || !args.project) return invalid('project is a folder id or an absolute directory');
    if (isAbsolute(args.project)) cwd = canonicalPath(args.project);
    else {
      const folder = folderNamed(args.project);
      if (!folder) throw Object.assign(new Error('That folder is not on this machine'), { code: 'not-found' });
      cwd = folder.path;
    }
  }
  const [page, registeredRemotes] = await Promise.all([
    getLocalSessionSource().list({ engine: source, cwd, offset, limit }),
    db.select({ path: workspaces.path, url: workspaceRemotes.remoteUrl }).from(workspaces)
      .innerJoin(workspaceRemotes, and(eq(workspaceRemotes.workspaceId, workspaces.id), eq(workspaceRemotes.remoteName, 'origin'))),
  ]);
  // Transcripts group under this computer's recorded folders (the grouping leaves the task home out by its path).
  const localGroupOf = createLocalGroupOf([...listFolders(), ...listUnboundFolders()].map(({ path }) => ({ path, name: basename(path) || path })));
  const remotes = new Map<string, string | null>(registeredRemotes.flatMap(({ path, url }) => (path ? [[path, url] as const] : [])));
  const repositories = new Map<string | null, Promise<Pick<AppSessionGroup, 'repositoryUrl' | 'repositoryError'>>>();
  // @@@group-repository - `findRepoRoot` only reads the disk (a `.git` there), so git has the last word: a folder git calls
  // "not a repository" (an empty `.git`) is a plain folder; any other failure is this group's, said on it, never the index's.
  const repositoryOf = async (key: string): Promise<Pick<AppSessionGroup, 'repositoryUrl' | 'repositoryError'>> => {
    if (remotes.has(key)) return { repositoryUrl: parseRepositoryRef(remotes.get(key))?.repositoryUrl };
    if (!isAbsolute(key) || findRepoRoot(key) !== key) return {};
    try {
      const { runtimeManager } = await import('@main/core/runtime/runtime-manager');
      const runtime = await runtimeManager.acquire();
      try {
        const repository = await runtime.value.git.openRepository(key);
        try {
          const url = (await repository.value.getRemotes()).remotes.find((remote) => remote.name === 'origin')?.url;
          return { repositoryUrl: parseRepositoryRef(url)?.repositoryUrl };
        } finally { await repository.release(); }
      } finally { await runtime.release(); }
    } catch (error) {
      return isNotRepositoryInspectionError(error) ? {} : { repositoryError: gitErrorMessage(error) };
    }
  };
  const groupOf = async (directory: string | null): Promise<AppSessionGroup> => {
    const group = localGroupOf(directory);
    if (!group.key) return group;
    if (!repositories.has(group.key)) repositories.set(group.key, repositoryOf(group.key));
    const { repositoryUrl, repositoryError } = await repositories.get(group.key)!;
    return { ...group, ...(repositoryUrl ? { repositoryUrl } : {}), ...(repositoryError ? { repositoryError } : {}) };
  };
  const next = offset + page.rows.length;
  return {
    rows: await Promise.all(page.rows.map(async ({ engine, ...row }) => ({ source: engine, ...row, group: await groupOf(row.cwd) }))),
    groups: await Promise.all(groupPaths.map(async (path) => ({ path, group: await groupOf(resolve(path)) }))),
    total: page.matched, pending: page.pending, stale: page.stale,
    nextOffset: next < page.matched ? next : null,
  };
}

export async function readSessionForApp(args: Record<string, unknown>) {
  const source = sourceOf(args.source);
  if (!source || typeof args.filePath !== 'string' || !args.filePath) return invalid('read names a source and an indexed filePath');
  if (args.view !== undefined && args.view !== 'conversation' && args.view !== 'context') return invalid('view is conversation or context');
  return getLocalSessionSource().read({ filePath: args.filePath, source, view: args.view, offset: sessionPageNumber(args.offset, 'offset', 0), limit: sessionPageNumber(args.limit, 'limit', 50) });
}
