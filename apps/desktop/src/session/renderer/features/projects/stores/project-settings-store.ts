import type { Result } from '@gugu/session-shared';
import { onMachineEvent, rpc } from '@renderer/lib/ipc';
import { machineRegistry } from '@renderer/lib/machine-routing';
import { workspaceEvents } from '@renderer/features/sessions/workspace-backend/workspace-backend';
import { Resource } from '@renderer/lib/stores/resource';
import { fileChangesChannel } from '@shared/core/fs/fsEvents';
import {
  isProjectConfigPath,
  type ProjectSettings,
  type ProjectSettingsOverrideState,
  type ProjectSettingsPage,
  type ProjectSettingsWriteTargetOption,
  type WriteProjectConfigRequest,
} from '@shared/core/project-settings/project-settings';
import { folderSettingsChangedChannel } from '@shared/core/folders/folder-events';
import type { UpdateProjectSettingsError } from '@shared/projects';

export class ProjectSettingsStore {
  readonly pageData: Resource<ProjectSettingsPage>;
  private readonly _unsubscribeConfigWatch: () => void;
  private readonly _unsubscribeSettingsChanged: () => void;

  constructor(private readonly projectId: string) {
    this.pageData = new Resource(async () => {
      const result = await rpc.folderSettings.getSettingsPage(projectId);
      if (!result.success) {
        throw new Error(
          result.error.type === 'project-not-found'
            ? `Project ${projectId} not found`
            : 'Failed to load project settings'
        );
      }
      return result.data;
    }, [{ kind: 'demand' }]);

    this._unsubscribeConfigWatch = workspaceEvents.on(fileChangesChannel, (data) => {
      // A folder's config files sit at its root, the folder's own workspace (whose id is the folder id).
      if (data.workspaceId !== projectId) return;
      if (
        data.update.kind === 'resync' ||
        data.update.changes.some((change) => isProjectConfigPath(change.path))
      ) {
        this.pageData.invalidate();
      }
    });

    this._unsubscribeSettingsChanged = onMachineEvent(machineRegistry.machineOf(projectId), folderSettingsChangedChannel, (data) => {
      if (data.folderId === projectId) {
        this.pageData.invalidate();
      }
    });
  }

  get settings(): ProjectSettings | null {
    return this.pageData.data?.settings ?? null;
  }

  get writeTargets(): ProjectSettingsWriteTargetOption[] | null {
    return this.pageData.data?.writeTargets ?? null;
  }

  get overrideState(): ProjectSettingsOverrideState | null {
    return this.pageData.data?.overrideState ?? null;
  }

  async load(): Promise<ProjectSettingsPage | null> {
    await this.pageData.load();
    return this.pageData.data;
  }

  async save(
    settings: ProjectSettings
  ): Promise<Result<ProjectSettings, UpdateProjectSettingsError>> {
    const result = await rpc.folderSettings.updateSettings(this.projectId, settings);
    if (result.success) {
      const current = this.pageData.data;
      if (current) this.pageData.setValue({ ...current, settings: result.data });
      else this.pageData.invalidate();
    }
    return result;
  }

  async writeConfigToRepo(
    request: WriteProjectConfigRequest
  ): Promise<Result<ProjectSettingsPage, UpdateProjectSettingsError>> {
    const result = await rpc.folderSettings.shareSettingsToConfig(this.projectId, request);
    if (result.success) {
      this.pageData.setValue(result.data);
    }
    return result;
  }

  dispose(): void {
    this._unsubscribeConfigWatch();
    this._unsubscribeSettingsChanged();
    this.pageData.dispose();
  }
}
