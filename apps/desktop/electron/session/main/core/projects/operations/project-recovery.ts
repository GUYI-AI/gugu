import { canonicalPath } from '@gugu/session-core/files';
import { err, ok, type Result } from '@gugu/session-shared';
import { and, eq, ne, sql } from 'drizzle-orm';
import { db } from '@main/db/client';
import { projects, workspaces } from '@main/db/schema';
import { computeWorkspaceKey } from '@main/core/workspaces/workspace-key';
import { projectManager } from '../project-manager';
import { getDirectoryStatus } from '../path-utils';
import type { LocalProject, ProjectRecoveryError, UnavailableProject } from '@shared/projects';
import { getLocalProjectByPath, getProjectById, getProjectPathOccupant, getProjects } from './getProjects';
import { getLocalProjectPathStatus } from './create-local-project';
import { ensureRepositoryWorkspace } from './ensure-repository-workspace';
import { listProjectGroupBindings } from './project-groups';
import { getProjectOwningAttachedFolder } from './project-folders';
import { publishProjectVisibility } from './project-visibility';
import { projectEvents } from '../project-events';
import { events } from '@main/lib/events';
import { projectRootRestoredChannel } from '@shared/core/projects/projectEvents';

/** Same directory probe as openProject; inspection failures are never evidence of a missing folder. */
export async function listUnavailableProjects(): Promise<UnavailableProject[]> {
  const [rows, bindings] = await Promise.all([getProjects(), listProjectGroupBindings()]);
  if (!bindings.success) throw new Error(bindings.error.message);
  const chats = new Map(bindings.data.map(row => [row.projectId, row.chatId]));
  const local = rows.filter(row => row.kind !== 'workspace' && !row.rootFolderDetached);
  const states = new Map(local.map(row => [row.id, getDirectoryStatus(row.path)]));
  return local.filter(row => {
    if (states.get(row.id)?.kind !== 'not-directory') return false;
    const chatId = chats.get(row.id);
    // A project group with another usable (or unverified) local folder is not lost on this computer.
    return !chatId || !local.some(other => chats.get(other.id) === chatId && states.get(other.id)?.kind !== 'not-directory');
  }).map(row => ({ id: row.id, name: row.name, path: row.path, chatId: chats.get(row.id) ?? null }));
}

/** Exact retained path only: moved or renamed folders never inherit an old project's identity. */
export async function findRetainedProjectAtPath(path: string): Promise<UnavailableProject | null> {
  const project = await getLocalProjectByPath(path);
  if (!project || project.kind === 'workspace') return null;
  const bindings = await listProjectGroupBindings();
  if (!bindings.success) throw new Error(bindings.error.message);
  return { id: project.id, name: project.name, path: project.path, chatId: bindings.data.find(row => row.projectId === project.id)?.chatId ?? null };
}

export async function inspectProjectRecovery(projectId: string, folder: string): Promise<Result<{ path: LocalProject['path']; isGitRepo: boolean }, ProjectRecoveryError>> {
  const project = await getProjectById(projectId);
  if (!project || project.kind === 'workspace') return err({ type: 'not-found', message: '没有这个项目。' });
  let path: LocalProject['path'];
  try { path = canonicalPath(folder); }
  catch { return err({ type: 'invalid-directory', message: '请选择一个可用的文件夹。' }); }
  const status = await getLocalProjectPathStatus(path);
  if (status.error) return err({ type: 'inspect-failed', message: '无法读取这个文件夹，请检查访问权限。' });
  if (!status.isDirectory) return err({ type: 'invalid-directory', message: '请选择一个可用的文件夹。' });
  const [occupant, attached] = await Promise.all([getProjectPathOccupant(path), getProjectOwningAttachedFolder(path)]);
  const rootId = project.repositoryWorkspaceId;
  const key = computeWorkspaceKey(path);
  const workspace = db.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.key, key)).get();
  if (occupant && occupant.id !== projectId || attached && attached.id !== projectId || workspace && workspace.id !== rootId) {
    return err({ type: 'path-conflict', message: '这个文件夹已属于其他项目，请选择另一个文件夹。' });
  }
  return ok({ path, isGitRepo: status.isGitRepo });
}

/** User-selected repair only. The original project, root workspace, sessions and group mapping stay in place. */
export async function restoreProjectFolder(projectId: string, folder: string): Promise<Result<LocalProject, ProjectRecoveryError>> {
  const inspected = await inspectProjectRecovery(projectId, folder);
  if (!inspected.success) return inspected;
  const project = await getProjectById(projectId);
  if (!project) return err({ type: 'not-found', message: '没有这个项目。' });
  const closed = await projectManager.closeProject(projectId);
  if (!closed.success) return err({ type: 'close-failed', message: '项目仍在使用中，请稍后恢复。' });
  const { path, isGitRepo } = inspected.data;
  try {
    db.transaction(tx => {
      const rootId = ensureRepositoryWorkspace(project, tx);
      const key = computeWorkspaceKey(path);
      const occupiedProject = tx.select({ id: projects.id }).from(projects).where(and(eq(projects.path, path), ne(projects.id, projectId))).get();
      const occupiedWorkspace = tx.select({ id: workspaces.id }).from(workspaces).where(and(eq(workspaces.key, key), ne(workspaces.id, rootId))).get();
      if (occupiedProject || occupiedWorkspace) throw new Error('path-conflict');
      tx.update(projects).set({ path, gitless: !isGitRepo, archivedAt: null, updatedAt: sql`CURRENT_TIMESTAMP` }).where(eq(projects.id, projectId)).run();
      tx.update(workspaces).set({ path, key }).where(eq(workspaces.id, rootId)).run();
    });
  } catch (error) {
    if (error instanceof Error && error.message === 'path-conflict') return err({ type: 'path-conflict', message: '这个文件夹已属于其他项目，请选择另一个文件夹。' });
    throw error;
  }
  const restored = (await getProjectById(projectId))!;
  events.emit(projectRootRestoredChannel, { project: restored });
  await publishProjectVisibility(projectId);
  projectEvents._emit('project:created', restored);
  return ok(restored);
}
