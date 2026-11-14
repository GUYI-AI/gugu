import type { Hotkey } from '@tanstack/react-hotkeys';
import { COMMANDS, type CommandId } from '@shared/commands';
import { resolveDefaultHotkey } from '@shared/shortcuts';
import { useAppSettingsKey } from '@renderer/features/settings/use-app-settings-key';

export type { CommandDef, CommandId } from '@shared/commands';
export { COMMANDS } from '@shared/commands';
export { resolveDefaultHotkey, sharesChordIntentionally } from '@shared/shortcuts';

type ShortcutOverrides = Partial<Record<CommandId, string | null>>;

export function isHostCommandId(id: string): id is CommandId {
  return Object.hasOwn(COMMANDS, id);
}

/**
 * Returns the currently assigned hotkey for an action.
 * - `undefined` override -> falls back to default
 * - `null` override -> unassigned (disabled)
 * - no `defaultHotkey` and no override -> `null` (not bound)
 * - `custom === null`: the user's bindings are not read yet -> `null` (nothing bound or shown until they are)
 */
export function getEffectiveHotkey(
  key: CommandId,
  custom?: ShortcutOverrides | null
): Hotkey | null {
  if (custom === null) return null;
  const configured = custom?.[key];
  if (configured === null) return null;
  const resolved = configured ?? resolveDefaultHotkey(COMMANDS[key]);
  return resolved != null ? (resolved as Hotkey) : null;
}

/**
 * Always returns a valid hotkey string for hook registration.
 * Pair this with `getEffectiveHotkey(...) !== null` in `enabled`.
 */
export function getHotkeyRegistration(
  key: CommandId,
  custom?: ShortcutOverrides | null
): Hotkey {
  return (getEffectiveHotkey(key, custom) ??
    resolveDefaultHotkey(COMMANDS[key]) ??
    '') as Hotkey;
}

/**
 * The user's shortcut overrides from the settings read model; null until read. While null nothing is bound and no
 * shortcut label is drawn — a default chord shown or bound before the user's own binding is known is a fake value.
 */
export function useShortcutOverrides(): ShortcutOverrides | null {
  const { settings } = useAppSettingsKey('keyboard');
  return settings.state === 'value' ? settings.value.value : null;
}
