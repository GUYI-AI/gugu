import type { IFileSystem } from '@gugu/session-core/files';
import { err, ok, type Result } from '@gugu/session-shared';
import { appSettingsService } from '@main/core/settings/settings-service';
import { log } from '@main/lib/logger';
import { remoteNameFromQualifiedRef } from '@shared/core/git/utils';
import {
  baseProjectSettingsSchema,
  DEFAULT_PRESERVE_PATTERNS,
  legacyBaseProjectSettingsSchema,
  projectSettingsSchema,
  shareableProjectSettingsSchema,
  type BaseProjectSettings,
  type ProjectSettings,
  type ShareableProjectSettings,
} from '@shared/core/project-settings/project-settings';
import { SHAREABLE_FIELD_ACCESSORS } from '@shared/core/project-settings/project-settings-fields';
import type { UpdateProjectSettingsError } from '@shared/projects';
import {
  migrateLegacyProjectSettingsIfNeeded,
  type ProjectSettingsGitInspector,
} from '../legacy-project-settings-migration';
import {
  hasLegacyShareableConfigMigrated,
  serializeShareableProjectSettings,
} from '../legacy-shareable-migration-marker';
import { compactUndefined, parseJsonObject, readJson } from '../project-settings-json';
import { FolderSettingsRepository } from '../folder-settings-storage';
import type { ProjectSettingsPatch, FolderSettingsProvider } from '../provider';
import { CONFIG_FILE, LEGACY_CONFIG_FILE } from '../sharing/workspace-config-file';

export type DbFolderSettingsProviderOptions = {
  git?: ProjectSettingsGitInspector;
};

export abstract class DbFolderSettingsProvider implements FolderSettingsProvider {
  private legacyMigrationPromise: Promise<void> | undefined;
  private readonly storage = new FolderSettingsRepository();

  protected constructor(
    private readonly folderId: string,
    protected readonly folderPath: string,
    protected readonly defaultBranchFallback: string = 'main',
    private readonly configReader: Pick<IFileSystem, 'exists' | 'readText'> | undefined,
    private readonly joinFolderPath: (rootPath: string, relPath: string) => string,
    private readonly options: DbFolderSettingsProviderOptions = {}
  ) {}

  protected async initialBaseProjectSettings(): Promise<BaseProjectSettings> {
    const defaultBranch = this.defaultBranchFallback.trim() || 'main';
    const projectDefaults = await appSettingsService.get('project');
    return {
      defaultBranch,
      baseRemote: remoteNameFromQualifiedRef(defaultBranch) ?? 'origin',
      tmux: projectDefaults.tmuxByDefault,
    };
  }

  /**
   * 共享配置文件读哪一份:新名字优先,读不到再看改名前那份。都不在就返回新名字
   * (调用方的 `exists` 会照常报 false)。
   */
  private async resolveConfigPathForRead(): Promise<string> {
    const currentPath = this.folderFilePath(CONFIG_FILE);
    if (!this.configReader) return currentPath;
    const current = await this.configReader.exists(currentPath);
    if (current.success && current.data) return currentPath;
    const legacyPath = this.folderFilePath(LEGACY_CONFIG_FILE);
    const legacy = await this.configReader.exists(legacyPath);
    return legacy.success && legacy.data ? legacyPath : currentPath;
  }

  private async hasSharedPreservePatterns(): Promise<boolean> {
    if (!this.configReader) return false;
    const configPath = await this.resolveConfigPathForRead();
    try {
      const exists = await this.configReader.exists(configPath);
      if (!exists.success || !exists.data) return false;
      const content = await this.configReader.readText(configPath);
      if (!content.success) return false;
      if (content.data.truncated) {
        log.warn('Shared project settings were truncated during initialization', {
          path: configPath,
          totalSize: content.data.totalSize,
        });
        return false;
      }
      const parsed = shareableProjectSettingsSchema.safeParse(
        parseJsonObject(content.data.content)
      );
      if (!parsed.success) {
        log.warn('Failed to inspect shared project settings during initialization', parsed.error);
        return false;
      }
      return parsed.data.preservePatterns !== undefined;
    } catch (error) {
      log.warn('Failed to inspect shared project settings during initialization', error);
      return false;
    }
  }

  private folderFilePath(relPath: string): string {
    return this.joinFolderPath(this.folderPath, relPath);
  }

  private async ensureRow(): Promise<void> {
    if (await this.storage.get(this.folderId)) return;

    const baseSettings = await this.initialBaseProjectSettings();
    const shareableSettings = (await this.hasSharedPreservePatterns())
      ? {}
      : { preservePatterns: [...DEFAULT_PRESERVE_PATTERNS] };
    await this.storage.insertIfMissing(this.folderId, {
      baseProjectSettingsJson: JSON.stringify(compactUndefined(baseSettings)),
      shareableProjectSettingsJson: serializeShareableProjectSettings(shareableSettings),
      legacyConfigMigratedAt: null,
    });
  }

  private async readSettingsRow(): Promise<{
    base: BaseProjectSettings;
    shareable: ShareableProjectSettings;
    legacyConfigMigratedAt: string | null;
  }> {
    await this.ensureRow();
    await this.migrateLegacyConfigIfNeeded();
    const row = await this.storage.get(this.folderId);
    if (!row) {
      return {
        base: await this.initialBaseProjectSettings(),
        shareable: {},
        legacyConfigMigratedAt: null,
      };
    }
    const baseSettings = readJson(
      row.baseProjectSettingsJson,
      legacyBaseProjectSettingsSchema,
      'base project settings'
    );
    const { remote, ...canonicalBaseSettings } = baseSettings;

    return {
      base: baseProjectSettingsSchema.parse({
        ...canonicalBaseSettings,
        baseRemote: canonicalBaseSettings.baseRemote ?? remote,
      }),
      shareable: readJson(
        row.shareableProjectSettingsJson,
        shareableProjectSettingsSchema,
        'shareable project settings'
      ),
      legacyConfigMigratedAt: row.legacyConfigMigratedAt,
    };
  }

  private async migrateLegacyConfigIfNeeded(git = this.options.git): Promise<void> {
    if (this.legacyMigrationPromise) {
      await this.legacyMigrationPromise;
      return;
    }

    this.legacyMigrationPromise = (async () => {
      const row = await this.storage.get(this.folderId);
      await migrateLegacyProjectSettingsIfNeeded({
        folderId: this.folderId,
        row,
        configReader: this.configReader,
        configPath: await this.resolveConfigPathForRead(),
        defaultBranchFallback: this.defaultBranchFallback,
        storage: this.storage,
        git,
      });
    })();

    try {
      await this.legacyMigrationPromise;
    } catch (error) {
      this.legacyMigrationPromise = undefined;
      throw error;
    }
  }

  async ensure(options: DbFolderSettingsProviderOptions = {}): Promise<void> {
    await this.ensureRow();
    await this.migrateLegacyConfigIfNeeded(options.git);
  }

  /**
   * gugu #2328: 迁移是否仍未完成 — 纯本地 DB 读。调用方用它决定要不要为 ensure 传 git
   * 句柄,迁移已标记完成时可全程不碰 git。
   */
  async needsLegacyConfigMigration(): Promise<boolean> {
    const row = await this.storage.get(this.folderId);
    if (!row) return true;
    return !(
      Boolean(row.legacyConfigMigratedAt) &&
      hasLegacyShareableConfigMigrated(row.shareableProjectSettingsJson)
    );
  }

  async get(): Promise<ProjectSettings> {
    const { base, shareable } = await this.readSettingsRow();
    return projectSettingsSchema.parse({ ...base, ...shareable });
  }

  async update(settings: ProjectSettings): Promise<Result<void, UpdateProjectSettingsError>> {
    const parsed = projectSettingsSchema.safeParse(settings);
    if (!parsed.success) {
      return err({ type: 'invalid-settings' });
    }

    const nextSettings = parsed.data;

    const base = baseProjectSettingsSchema.parse(nextSettings);
    const shareable = shareableProjectSettingsSchema.parse(nextSettings);

    try {
      await this.ensure();
      const row = await this.storage.get(this.folderId);
      await this.storage.update(this.folderId, {
        baseProjectSettingsJson: JSON.stringify(compactUndefined(base)),
        shareableProjectSettingsJson: serializeShareableProjectSettings(shareable, {
          previousRaw: row?.shareableProjectSettingsJson,
        }),
      });
      return ok();
    } catch (error) {
      log.warn('Failed to update project settings', error);
      return err({ type: 'error' });
    }
  }

  async patch(patch: ProjectSettingsPatch): Promise<Result<void, UpdateProjectSettingsError>> {
    try {
      await this.ensure();
      const row = await this.storage.get(this.folderId);
      const base = row
        ? readJson(
            row.baseProjectSettingsJson,
            legacyBaseProjectSettingsSchema,
            'base project settings'
          )
        : await this.initialBaseProjectSettings();
      const shareable = row
        ? readJson(
            row.shareableProjectSettingsJson,
            shareableProjectSettingsSchema,
            'shareable project settings'
          )
        : {};

      for (const field of patch.clearShareableFields ?? []) {
        SHAREABLE_FIELD_ACCESSORS[field].clear(shareable);
      }

      const nextBase = baseProjectSettingsSchema.parse({
        ...base,
        ...(Object.hasOwn(patch, 'githubAccountId')
          ? { githubAccountId: patch.githubAccountId }
          : {}),
      });

      await this.storage.update(this.folderId, {
        baseProjectSettingsJson: JSON.stringify(compactUndefined(nextBase)),
        shareableProjectSettingsJson: serializeShareableProjectSettings(shareable, {
          previousRaw: row?.shareableProjectSettingsJson,
        }),
      });
      return ok();
    } catch (error) {
      log.warn('Failed to clear shareable project settings', error);
      return err({ type: 'error' });
    }
  }

  async getDefaultBranch(): Promise<string> {
    const settings = await this.get();
    const branch = settings.defaultBranch;
    if (!branch) return this.defaultBranchFallback;
    if (typeof branch === 'string') return branch;
    const remote = settings.baseRemote ?? 'origin';
    return `${remote}/${branch.name}`;
  }

  async getBaseRemote(): Promise<string> {
    const settings = await this.get();
    return settings.baseRemote ?? 'origin';
  }

  async getPushRemote(): Promise<string> {
    const settings = await this.get();
    return settings.pushRemote ?? settings.baseRemote ?? 'origin';
  }

}
