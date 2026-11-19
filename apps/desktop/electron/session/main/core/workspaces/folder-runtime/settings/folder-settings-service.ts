import { err, ok, type Result } from '@gugu/session-shared';
import type { IInitializable } from '@gugu/session-shared';
import { events } from '@main/lib/events';
import { HookCore, type Hookable } from '@main/lib/hookable';
import { log } from '@main/lib/logger';
import {
  type MigrateProjectConfigRequest,
  type MigrateProjectConfigResult,
  type ProjectSettingsPatch,
  type ProjectSettings,
  type ProjectSettingsPage,
  type WriteProjectConfigRequest,
} from '@shared/core/project-settings/project-settings';
import { hasConfiguredShareableProjectSettings } from '@shared/core/project-settings/project-settings-fields';
import { folderSettingsChangedChannel } from '@shared/core/folders/folder-events';
import type { UpdateProjectSettingsError } from '@shared/projects';
import type { FolderRuntime } from '../folder-runtime';
import { openFolder } from '../folder-runtimes';
import {
  inspectProjectConfigMigrations,
  migrateProjectConfigFromProvider,
} from './sharing/config-migration';
import { computeProjectSettingsOverrideState } from './sharing/project-settings-override-state';
import {
  getProjectSettingsWriteTargets,
  resolveAllProjectSettingsTargets,
} from './sharing/project-settings-target-resolver';
import { shareProjectSettingsToConfig as writeSharedProjectSettingsToConfig } from './sharing/share-project-settings-to-config';

export type FolderSettingsHooks = {
  'folder-settings:changed': (event: {
    folderId: string;
    settings: ProjectSettings;
  }) => void | Promise<void>;
};

export class FolderSettingsService implements Hookable<FolderSettingsHooks>, IInitializable {
  private readonly _hooks = new HookCore<FolderSettingsHooks>((name, e) =>
    log.error(`FolderSettingsService: ${String(name)} hook error`, e)
  );
  private _disposeRendererBridge: (() => void) | null = null;

  on<K extends keyof FolderSettingsHooks>(name: K, handler: FolderSettingsHooks[K]) {
    return this._hooks.on(name, handler);
  }

  initialize(): void {
    this._disposeRendererBridge?.();
    this._disposeRendererBridge = this.on('folder-settings:changed', ({ folderId }) => {
      events.emit(folderSettingsChangedChannel, { folderId });
    });
  }

  async getSettingsPage(
    folderId: string
  ): Promise<Result<ProjectSettingsPage, UpdateProjectSettingsError>> {
    const folder = await this.requireFolder(folderId);
    if (!folder.success) return folder;
    return ok(await this.pageFor(folder.data));
  }

  async updateSettings(
    folderId: string,
    settings: ProjectSettings
  ): Promise<Result<ProjectSettings, UpdateProjectSettingsError>> {
    const folder = await this.requireFolder(folderId);
    if (!folder.success) return folder;

    const result = await folder.data.settings.update(settings);
    if (!result.success) return result;

    const updatedSettings = await folder.data.settings.get();
    this.emitSettingsChanged(folderId, updatedSettings);
    return ok(updatedSettings);
  }

  async patchSettings(
    folderId: string,
    patch: ProjectSettingsPatch
  ): Promise<Result<ProjectSettings, UpdateProjectSettingsError>> {
    const folder = await this.requireFolder(folderId);
    if (!folder.success) return folder;

    const result = await folder.data.settings.patch(patch);
    if (!result.success) return result;

    const updatedSettings = await folder.data.settings.get();
    this.emitSettingsChanged(folderId, updatedSettings);
    return ok(updatedSettings);
  }

  async shareSettingsToConfig(
    folderId: string,
    request: WriteProjectConfigRequest
  ): Promise<Result<ProjectSettingsPage, UpdateProjectSettingsError>> {
    const folder = await this.requireFolder(folderId);
    if (!folder.success) return folder;

    const resolvedTargets = await resolveAllProjectSettingsTargets(folder.data);
    const result = await writeSharedProjectSettingsToConfig(folder.data, request, resolvedTargets);
    if (!result.success) return result;

    const page = await this.pageFor(folder.data);
    this.emitSettingsChanged(folderId, page.settings);
    return ok(page);
  }

  async migrateConfig(
    folderId: string,
    request: MigrateProjectConfigRequest
  ): Promise<Result<MigrateProjectConfigResult, UpdateProjectSettingsError>> {
    const folder = await this.requireFolder(folderId);
    if (!folder.success) return folder;

    const settings = await folder.data.settings.get();
    if (hasConfiguredShareableProjectSettings(settings)) {
      return err({
        type: 'write-config-failed',
        message: 'Shareable project settings are already configured.',
      });
    }

    const result = await migrateProjectConfigFromProvider(folder.data, request);
    if (!result.success) return result;

    const page = await this.pageFor(folder.data);
    this.emitSettingsChanged(folderId, page.settings);
    return ok({ page, migration: result.data });
  }

  private async requireFolder(folderId: string): Promise<Result<FolderRuntime, UpdateProjectSettingsError>> {
    const opened = await openFolder(folderId);
    return opened.success ? ok(opened.data) : err({ type: 'project-not-found' });
  }

  private async pageFor(
    folder: FolderRuntime
  ): Promise<ProjectSettingsPage> {
    const settings = await folder.settings.get();
    const resolvedTargets = await resolveAllProjectSettingsTargets(folder);
    const writeTargets = getProjectSettingsWriteTargets(resolvedTargets);
    const overrideState = await computeProjectSettingsOverrideState(resolvedTargets);
    const configMigrations = hasConfiguredShareableProjectSettings(settings)
      ? []
      : await inspectProjectConfigMigrations(folder);
    return {
      settings,
      writeTargets,
      overrideState,
      configMigrations,
      shouldPromptConfigMigration: configMigrations.length > 0,
    };
  }

  private emitSettingsChanged(folderId: string, settings: ProjectSettings): void {
    this._hooks.callHookBackground('folder-settings:changed', { folderId, settings });
  }
}

export const folderSettingsService = new FolderSettingsService();
