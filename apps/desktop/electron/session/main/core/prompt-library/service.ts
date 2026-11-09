import { userIdFromSupabaseAccessToken } from '@gugu/core';
import { createGuguSupabaseClient } from '@gugu/core/cloud/supabase';
import type { VersionedSettingsTableClient } from '@gugu/core/cloud/userSettings';
import type { IInitializable } from '@gugu/session-shared';
import { eq } from 'drizzle-orm';
import { currentAccountAccessToken } from '@main/core/extensions/account-token';
import { db } from '@main/db/client';
import { KV } from '@main/db/kv';
import { log } from '@main/lib/logger';
import { appSettings } from '@main/db/schema';
import {
  PROMPT_LIBRARY_SEED_VERSION,
  editCloudPrompts,
  promptLibrarySchema,
  readCloudPrompts,
  type PromptLibrary,
  type PromptLibraryPrompt,
  type PromptOverride,
} from '@shared/prompt-library';

type PromptLibraryKV = {
  prompts: PromptLibraryPrompt[];
  seedVersion: number;
  /** The last list read for an account here: what `/` shows while the cloud can't be reached. */
  lastRead: { userId: string; library: PromptLibrary };
};

type PromptEdit = (prompts: PromptLibraryPrompt[]) => PromptLibraryPrompt[];

/**
 * The prompts are the account's (owner 11-07): one `user_settings` row (prompt-library.ts). Main reads and writes it
 * with the account's token — the session page is given no credentials (assistantPanelBridge.ts).
 */
async function account(): Promise<{ client: VersionedSettingsTableClient; userId: string }> {
  const token = await currentAccountAccessToken();
  const userId = token ? userIdFromSupabaseAccessToken(token) : null;
  if (!token || !userId) throw Object.assign(new Error('Not signed in'), { code: 'failed' });
  return { client: createGuguSupabaseClient({ schema: 'identity', headers: { Authorization: `Bearer ${token}` } }) as unknown as VersionedSettingsTableClient, userId };
}

const promptLibraryKV = new KV<PromptLibraryKV>('prompt-library');
const warn = (message: string) => log.warn(message);

export class PromptLibraryService implements IInitializable {
  private seedPromise: Promise<void> | null = null;

  private async readPrompts(): Promise<PromptLibraryPrompt[]> {
    const prompts = await promptLibraryKV.get('prompts');
    const parsed = promptLibrarySchema.safeParse(prompts ?? []);
    return parsed.success ? parsed.data : [];
  }

  private async readLegacyAppSetting(key: string): Promise<unknown | null> {
    const rows = await db
      .select({ value: appSettings.value })
      .from(appSettings)
      .where(eq(appSettings.key, key))
      .limit(1);
    const raw = rows[0]?.value;
    if (!raw) return null;

    try {
      return JSON.parse(raw) as unknown;
    } catch {
      return null;
    }
  }

  private async deleteLegacyPromptSettings(): Promise<void> {
    await db.delete(appSettings).where(eq(appSettings.key, 'promptLibrary'));
    await db.delete(appSettings).where(eq(appSettings.key, 'promptLibrarySeedVersion'));
    await db.delete(appSettings).where(eq(appSettings.key, 'reviewPrompt'));
  }

  private async seedIfNeeded(): Promise<void> {
    if (this.seedPromise) return this.seedPromise;

    this.seedPromise = (async () => {
      const seedVersion = await promptLibraryKV.get('seedVersion');
      if ((seedVersion ?? 0) >= PROMPT_LIBRARY_SEED_VERSION) {
        await this.deleteLegacyPromptSettings();
        return;
      }

      const existingPrompts = await this.readPrompts();
      const legacyPromptLibrary = promptLibrarySchema.safeParse(
        await this.readLegacyAppSetting('promptLibrary')
      );
      const legacyReviewPrompt = await this.readLegacyAppSetting('reviewPrompt');
      const prompts = [...existingPrompts];
      if (legacyPromptLibrary.success) {
        for (const legacyPrompt of legacyPromptLibrary.data) {
          if (!prompts.some((prompt) => prompt.id === legacyPrompt.id)) {
            prompts.push(legacyPrompt);
          }
        }
      }
      // 不再给新用户塞一条预设(10-07 资源库体检:中文界面里第一屏就是一条英文的「Review prompt」,
      // 空状态那句已经说清这页是干什么的)。老版本里用户**自己改过**的那条 review prompt 仍照搬过来 —— 那是他的内容。
      const legacyReview = typeof legacyReviewPrompt === 'string' && legacyReviewPrompt.trim()
        && !prompts.some((prompt) => prompt.id === 'review-prompt')
        ? [{ id: 'review-prompt', title: 'Review prompt', prompt: legacyReviewPrompt.trim() }]
        : [];
      const nextPrompts = [...legacyReview, ...prompts];

      if (nextPrompts.length > 0) {
        await promptLibraryKV.set('prompts', nextPrompts);
      }
      await promptLibraryKV.set('seedVersion', PROMPT_LIBRARY_SEED_VERSION);
      await this.deleteLegacyPromptSettings();
    })().finally(() => {
      this.seedPromise = null;
    });

    await this.seedPromise;
  }

  async initialize(): Promise<void> {
    await this.seedIfNeeded();
  }

  /**
   * This computer's old local list goes into the first account signed in here, once, by id; then it is cleared, so no
   * later account on this computer gets it.
   */
  private async mergeLocal(client: VersionedSettingsTableClient, userId: string): Promise<void> {
    await this.seedIfNeeded();
    const local = await this.readPrompts();
    if (local.length === 0) return;
    await editCloudPrompts(client, userId, (cloud) => ({ ...cloud, items: [...cloud.items, ...local.filter((prompt) => !cloud.items.some((other) => other.id === prompt.id))] }), warn);
    await promptLibraryKV.set('prompts', []);
  }

  private async remember(userId: string, library: PromptLibrary): Promise<PromptLibrary> {
    await promptLibraryKV.set('lastRead', { userId, library });
    return library;
  }

  /** The account's prompts and App-prompt overrides; offline, the last ones read here for that account. */
  async getPrompts(): Promise<PromptLibrary> {
    const { client, userId } = await account();
    try {
      await this.mergeLocal(client, userId);
      return await this.remember(userId, await readCloudPrompts(client, userId, warn));
    } catch (error) {
      const last = await promptLibraryKV.get('lastRead');
      if (last?.userId === userId) return last.library;
      throw error;
    }
  }

  /** Apply `edit` to the latest row's own prompts (conditional on its version); returns what was saved. */
  async editPrompts(edit: PromptEdit, overrides = (current: PromptLibrary['overrides']) => current): Promise<PromptLibrary> {
    const { client, userId } = await account();
    await this.mergeLocal(client, userId);
    return this.remember(userId, await editCloudPrompts(client, userId, (library) => ({ items: edit(library.items), overrides: overrides(library.overrides) }), warn));
  }

  /** Create, or replace the one with this id; the undo of a delete saves the prompt back. */
  savePrompt(prompt: PromptLibraryPrompt): Promise<PromptLibrary> {
    return this.editPrompts((all) => (all.some((item) => item.id === prompt.id) ? all.map((item) => (item.id === prompt.id ? prompt : item)) : [...all, prompt]));
  }

  deletePrompt(id: string): Promise<PromptLibrary> {
    return this.editPrompts((all) => all.filter((item) => item.id !== id));
  }

  /** Edit or hide an App's prompt for this person; null restores the App's own. */
  overridePrompt(key: string, override: PromptOverride | null): Promise<PromptLibrary> {
    return this.editPrompts((all) => all, ({ [key]: _, ...rest }) => (override ? { ...rest, [key]: override } : rest));
  }
}

export const promptLibraryService = new PromptLibraryService();
