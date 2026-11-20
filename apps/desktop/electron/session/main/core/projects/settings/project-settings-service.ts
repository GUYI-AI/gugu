import { err, ok, type Result } from '@gugu/session-shared';
import type { IInitializable } from '@gugu/session-shared';
import { events } from '@main/lib/events';
import { HookCore, type Hookable } from '@main/lib/hookable';
import { log } from '@main/lib/logger';
import {
  type ProjectSettingsPatch,
  type ProjectSettings,
  type ProjectSettingsPage,
  type WriteProjectConfigRequest,
} from '@shared/core/project-settings/project-settings';
import { projectSettingsChangedChannel } from '@shared/core/projects/projectEvents';
import type { UpdateProjectSettingsError } from '@shared/projects';
import { projectManager } from '../project-manager';
import type { ProjectProvider } from '../project-provider';
import { computeProjectSettingsOverrideState } from './sharing/project-settings-override-state';
import {
  getProjectSettingsWriteTargets,
  resolveAllProjectSettingsTargets,
} from './sharing/project-settings-target-resolver';
import { shareProjectSettingsToConfig as writeSharedProjectSettingsToConfig } from './sharing/share-project-settings-to-config';

export type ProjectSettingsHooks = {
  'project-settings:changed': (event: {
    projectId: string;
    settings: ProjectSettings;
  }) => void | Promise<void>;
};

export class ProjectSettingsService implements Hookable<ProjectSettingsHooks>, IInitializable {
  private readonly _hooks = new HookCore<ProjectSettingsHooks>((name, e) =>
    log.error(`ProjectSettingsService: ${String(name)} hook error`, e)
  );
  private _disposeRendererBridge: (() => void) | null = null;

  on<K extends keyof ProjectSettingsHooks>(name: K, handler: ProjectSettingsHooks[K]) {
    return this._hooks.on(name, handler);
  }

  initialize(): void {
    this._disposeRendererBridge?.();
    this._disposeRendererBridge = this.on('project-settings:changed', ({ projectId }) => {
      events.emit(projectSettingsChangedChannel, { projectId });
    });
  }

  async getProjectSettingsPage(
    projectId: string
  ): Promise<Result<ProjectSettingsPage, UpdateProjectSettingsError>> {
    const project = this.requireProject(projectId);
    if (!project.success) return project;
    return ok(await this.getProjectSettingsPageForProject(project.data));
  }

  async updateProjectSettings(
    projectId: string,
    settings: ProjectSettings
  ): Promise<Result<ProjectSettings, UpdateProjectSettingsError>> {
    const project = this.requireProject(projectId);
    if (!project.success) return project;

    const result = await project.data.settings.update(await withGitHubPick(projectId, settings));
    if (!result.success) return result;

    const updatedSettings = await withGitHubAccount(projectId, await project.data.settings.get());
    this.emitSettingsChanged(projectId, updatedSettings);
    return ok(updatedSettings);
  }

  async patchProjectSettings(
    projectId: string,
    patch: ProjectSettingsPatch
  ): Promise<Result<ProjectSettings, UpdateProjectSettingsError>> {
    const project = this.requireProject(projectId);
    if (!project.success) return project;

    const result = await project.data.settings.patch(await withGitHubPick(projectId, patch));
    if (!result.success) return result;

    const updatedSettings = await withGitHubAccount(projectId, await project.data.settings.get());
    this.emitSettingsChanged(projectId, updatedSettings);
    return ok(updatedSettings);
  }

  async shareProjectSettingsToConfig(
    projectId: string,
    request: WriteProjectConfigRequest
  ): Promise<Result<ProjectSettingsPage, UpdateProjectSettingsError>> {
    const project = this.requireProject(projectId);
    if (!project.success) return project;

    const resolvedTargets = await resolveAllProjectSettingsTargets(project.data);
    const result = await writeSharedProjectSettingsToConfig(project.data, request, resolvedTargets);
    if (!result.success) return result;

    const page = await this.getProjectSettingsPageForProject(project.data);
    this.emitSettingsChanged(projectId, page.settings);
    return ok(page);
  }

  private requireProject(projectId: string): Result<ProjectProvider, UpdateProjectSettingsError> {
    const project = projectManager.getProject(projectId);
    return project ? ok(project) : err({ type: 'project-not-found' });
  }

  private async getProjectSettingsPageForProject(
    project: ProjectProvider
  ): Promise<ProjectSettingsPage> {
    const settings = await withGitHubAccount(project.projectId, await project.settings.get());
    const resolvedTargets = await resolveAllProjectSettingsTargets(project);
    const writeTargets = getProjectSettingsWriteTargets(resolvedTargets);
    const overrideState = await computeProjectSettingsOverrideState(resolvedTargets);
    return { settings, writeTargets, overrideState };
  }

  private emitSettingsChanged(projectId: string, settings: ProjectSettings): void {
    this._hooks.callHookBackground('project-settings:changed', { projectId, settings });
  }
}

/**
 * A project's GitHub account is the password vault's grant to it (`host:github:project:<id>`), not a stored setting: a
 * `githubAccountId` written here (a credential id) becomes that grant and is not stored; `null` (「不用 GitHub」) is.
 */
async function withGitHubPick<T extends { githubAccountId?: string | null }>(projectId: string, value: T): Promise<T> {
  if (typeof value.githubAccountId !== 'string') return value;
  const { chooseProjectGitHubCredential, githubCredentials } = await import('@main/core/github/github-credential');
  const credential = (await githubCredentials()).find((item) => item.id === value.githubAccountId);
  if (!credential) throw new Error(`No saved GitHub credential ${value.githubAccountId}`);
  await chooseProjectGitHubCredential(projectId, credential.id, new URL(credential.origin).hostname);
  return { ...value, githubAccountId: undefined };
}
/** What the settings read back say: the account the project uses (its own pick, else the connector's), unless it uses none. */
async function withGitHubAccount<T extends { githubAccountId?: string | null }>(projectId: string, settings: T): Promise<T> {
  if (settings.githubAccountId === null) return settings;
  try {
    const { projectGitHubCredentialId } = await import('@main/core/github/github-credential');
    const id = await projectGitHubCredentialId('github.com', projectId);
    return id ? { ...settings, githubAccountId: id } : settings;
  } catch {
    return settings; // The vault cannot be read: the connector says why (GitHubAccountState.error); the settings page still opens.
  }
}

export const projectSettingsService = new ProjectSettingsService();
