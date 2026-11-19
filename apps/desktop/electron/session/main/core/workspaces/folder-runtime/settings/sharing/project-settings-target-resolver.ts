import type { IFileSystem } from '@gugu/session-core/files';
import { db } from '@main/db/client';
import { sessions } from '@main/db/schema';
import { basename } from 'node:path';
import { rootFolderOf } from '@main/core/folders/folders';
import type {
  ProjectSettingsWriteTarget,
  ProjectSettingsWriteTargetOption,
  WriteProjectConfigRequest,
} from '@shared/core/project-settings/project-settings';
import type { FolderRuntime } from '../../folder-runtime';
import { resolveWorkspace } from '@main/core/workspaces/resolve-workspace';
import { taskName } from '@main/core/sessions/task-name';

export type ProjectSettingsResolvedTarget = ProjectSettingsWriteTargetOption & {
  fileSystem: IFileSystem;
  configPath: string;
};

function stripTarget(target: ProjectSettingsWriteTargetOption): ProjectSettingsWriteTarget {
  if (target.type === 'project') return { type: 'project' };
  return { type: 'workspace', workspaceId: target.workspaceId };
}

export function stripResolvedTarget(
  target: ProjectSettingsResolvedTarget
): ProjectSettingsWriteTargetOption {
  const { configPath: _configPath, fileSystem: _fileSystem, ...option } = target;
  return option;
}

function targetKey(target: ProjectSettingsWriteTarget): string {
  if (target.type === 'project') return 'project';
  return `workspace:${target.workspaceId}`;
}

/** 一条会话挂着的、不是项目根目录的工作区(它自己的 worktree):可以单独写一份配置。 */
async function resolveSessionWorkspaceTarget(
  project: FolderRuntime,
  session: { title: string; workspaceId: string | null }
): Promise<ProjectSettingsResolvedTarget | null> {
  const workspace = session.workspaceId ? await resolveWorkspace(session.workspaceId) : undefined;
  if (!session.workspaceId || !workspace || workspace.path === project.repoPath) return null;
  return {
    type: 'workspace',
    workspaceId: session.workspaceId,
    label: session.title,
    path: workspace.path,
    fileSystem: workspace.fileSystem,
    configPath: workspace.configPath,
  };
}

export async function resolveAllProjectSettingsTargets(
  project: FolderRuntime
): Promise<ProjectSettingsResolvedTarget[]> {
  const projectFileSystem = resolveProjectFileSystem(project);
  if (!projectFileSystem) return [];

  const projectTarget: ProjectSettingsResolvedTarget = {
    type: 'project',
    label: basename(project.repoPath) || 'Folder',
    path: project.repoPath,
    fileSystem: projectFileSystem,
    configPath: project.configPath,
  };

  // The folder's sessions: those whose cwd is the folder or a directory inside it.
  const sessionRows = (await db
    .select({ id: sessions.id, config: sessions.config, workspaceId: sessions.workspaceId })
    .from(sessions))
    .filter((session) => session.workspaceId !== null && rootFolderOf(session.workspaceId)?.id === project.folderId);

  // 多条会话共享一个工作区时只列一次。
  const byWorkspace = new Map<string, ProjectSettingsResolvedTarget>();
  for (const session of sessionRows) {
    const target = await resolveSessionWorkspaceTarget(project, { title: taskName(session), workspaceId: session.workspaceId });
    if (target?.type === 'workspace' && !byWorkspace.has(target.workspaceId)) {
      byWorkspace.set(target.workspaceId, target);
    }
  }
  return [projectTarget, ...byWorkspace.values()];
}

export function getProjectSettingsWriteTargets(
  targets: ProjectSettingsResolvedTarget[]
): ProjectSettingsWriteTargetOption[] {
  return targets.map(stripResolvedTarget);
}

export async function resolveProjectSettingsTarget(
  project: FolderRuntime,
  request: Pick<WriteProjectConfigRequest, 'target'>,
  resolvedTargets: ProjectSettingsResolvedTarget[]
): Promise<ProjectSettingsResolvedTarget | null> {
  const target = resolvedTargets.find(
    (candidate) => targetKey(stripTarget(candidate)) === targetKey(request.target)
  );
  if (target) return target;

  if (request.target.type === 'workspace') {
    const workspace = await resolveWorkspace(request.target.workspaceId);
    if (!workspace) return null;
    return {
      type: 'workspace',
      workspaceId: request.target.workspaceId,
      label: 'Workspace',
      path: workspace.path,
      fileSystem: workspace.fileSystem,
      configPath: workspace.configPath,
    };
  }

  return null;
}

function resolveProjectFileSystem(project: FolderRuntime): IFileSystem | null {
  return project.fileSystem;
}
