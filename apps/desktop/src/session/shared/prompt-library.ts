import z from 'zod';
import {
  readUserSettingsConfig,
  updateUserSettingsConfig,
  type SettingsTableClient,
  type VersionedSettingsTableClient,
} from '@gugu/core/cloud/userSettings';
import { defineEvent } from '@shared/lib/ipc/events';

export const promptLibraryPromptSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  prompt: z.string().min(1),
});

export const promptLibrarySchema = z.array(promptLibraryPromptSchema);

export type PromptLibraryPrompt = z.infer<typeof promptLibraryPromptSchema>;

/**
 * The person's version of an App's prompt (owner 11-08): edited, or hidden. Keyed `<App id>/<prompt name>`. Loose: a
 * field a newer client adds is kept, not an error.
 */
const promptOverrideSchema = z.union([z.looseObject({ hidden: z.literal(true) }), z.looseObject({ title: z.string().min(1), prompt: z.string().min(1) })]);
export type PromptOverride = z.infer<typeof promptOverrideSchema>;

export type PromptLibrary = { items: PromptLibraryPrompt[]; overrides: Record<string, PromptOverride> };

export type AppPrompt = { key: string; title: string; prompt: string };
export type PromptState = 'default' | 'modified' | 'hidden';

/** What the library page offers on an App's prompt. A hidden one is only restored: editing it would turn it into 「已修改」. */
export const APP_PROMPT_ACTIONS: Record<PromptState, readonly ('edit' | 'hide' | 'restore')[]> = {
  default: ['edit', 'hide'],
  modified: ['edit', 'hide', 'restore'],
  hidden: ['restore'],
};

/**
 * An App's prompts as the person sees them, the one merge `/`, the library page and `gugu.prompts.list` share: their
 * override if any, else the App's current text, so an App update reaches what they never touched. Restoring the
 * default is removing the override.
 */
export function withOverrides<T extends AppPrompt>(prompts: readonly T[], overrides: PromptLibrary['overrides']): (T & { state: PromptState })[] {
  return prompts.map((prompt) => {
    const override = overrides[prompt.key];
    if (!override) return { ...prompt, state: 'default' };
    return 'hidden' in override ? { ...prompt, state: 'hidden' } : { ...prompt, title: override.title, prompt: override.prompt, state: 'modified' };
  });
}

export const PROMPT_LIBRARY_SEED_VERSION = 1;

/**
 * The person's prompts are the account's (owner 11-07): one `identity.user_settings` row, read by every computer. The
 * row and its RLS already exist, so this needs no migration; writes are conditional on the row's version
 * (`updateUserSettingsConfig`), so two computers never overwrite each other's edit. Its own scope, not a key of `user`:
 * a prompt edit never contends with the other settings' writes.
 */
const SCOPE = 'prompts';

/** Says which override was dropped and why (main's log). */
export type PromptWarn = (message: string) => void;

/** A broken override is dropped alone, said in `warn`: the person's prompts and the other overrides stay readable and writable. */
function libraryOf(config: Record<string, unknown>, warn: PromptWarn): PromptLibrary {
  const overrides = Object.entries(config.overrides ?? {}).flatMap(([key, value]) => {
    const parsed = promptOverrideSchema.safeParse(value);
    if (parsed.success) return [[key, parsed.data] as const];
    warn(`Prompt override ${key} dropped: ${parsed.error.message}`);
    return [];
  });
  return { items: promptLibrarySchema.parse(config.items ?? []), overrides: Object.fromEntries(overrides) };
}

export async function readCloudPrompts(client: SettingsTableClient, userId: string, warn: PromptWarn): Promise<PromptLibrary> {
  return libraryOf(await readUserSettingsConfig(client, userId, SCOPE), warn);
}

/**
 * Apply `edit` to the latest row. An override this client cannot read is written back as it was (a newer client's),
 * only never used here.
 */
export async function editCloudPrompts(
  client: VersionedSettingsTableClient,
  userId: string,
  edit: (library: PromptLibrary) => PromptLibrary,
  warn: PromptWarn,
): Promise<PromptLibrary> {
  const row = await updateUserSettingsConfig(client, userId, SCOPE, (config) => {
    const read = libraryOf(config, warn);
    const unread = Object.entries(config.overrides ?? {}).filter(([key]) => !(key in read.overrides));
    const next = libraryOf(edit(read), warn);
    return { ...config, items: next.items, overrides: { ...Object.fromEntries(unread), ...next.overrides } };
  });
  return libraryOf(row.config, warn);
}

/** Main → renderer: an App's program changed the person's prompts. The list re-reads; a delete offers its undo (saving it back). */
export const promptsChangedChannel = defineEvent<{ action: 'save' | 'delete'; prompt: PromptLibraryPrompt; app: string }>('prompts.changed');
