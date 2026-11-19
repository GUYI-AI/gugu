import { eq, sql } from 'drizzle-orm';
import { db } from '@main/db/client';
import { workspaceSettings } from '@main/db/schema';

export type StoredFolderSettings = {
  baseProjectSettingsJson: string;
  shareableProjectSettingsJson: string;
  legacyConfigMigratedAt: string | null;
};

export interface FolderSettingsStorage {
  get(folderId: string): Promise<StoredFolderSettings | undefined>;
  insertIfMissing(folderId: string, settings: StoredFolderSettings): Promise<void>;
  update(folderId: string, settings: Partial<StoredFolderSettings>): Promise<void>;
}

function toColumns(settings: Partial<StoredFolderSettings>) {
  return {
    ...(settings.baseProjectSettingsJson !== undefined && { baseSettingsJson: settings.baseProjectSettingsJson }),
    ...(settings.shareableProjectSettingsJson !== undefined && { shareableSettingsJson: settings.shareableProjectSettingsJson }),
    ...(settings.legacyConfigMigratedAt !== undefined && { legacyConfigMigratedAt: settings.legacyConfigMigratedAt }),
  };
}

/** A folder's settings row in `workspace_settings`, keyed by the folder's workspace id. */
export class FolderSettingsRepository implements FolderSettingsStorage {
  async get(folderId: string): Promise<StoredFolderSettings | undefined> {
    const row = db.select().from(workspaceSettings).where(eq(workspaceSettings.workspaceId, folderId)).get();
    if (!row) return undefined;
    return {
      baseProjectSettingsJson: row.baseSettingsJson,
      shareableProjectSettingsJson: row.shareableSettingsJson,
      legacyConfigMigratedAt: row.legacyConfigMigratedAt,
    };
  }

  async insertIfMissing(folderId: string, settings: StoredFolderSettings): Promise<void> {
    await db
      .insert(workspaceSettings)
      .values({ workspaceId: folderId, ...toColumns(settings), updatedAt: sql`CURRENT_TIMESTAMP` })
      .onConflictDoNothing();
  }

  async update(folderId: string, settings: Partial<StoredFolderSettings>): Promise<void> {
    await db
      .update(workspaceSettings)
      .set({ ...toColumns(settings), updatedAt: sql`CURRENT_TIMESTAMP` })
      .where(eq(workspaceSettings.workspaceId, folderId));
  }
}
