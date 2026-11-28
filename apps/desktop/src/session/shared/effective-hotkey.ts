import { normalizeHotkey, type Hotkey } from '@tanstack/hotkeys';
import { COMMANDS, type CommandAlias, type CommandId } from './commands';
import { detectShortcutPlatform, resolveDefaultHotkey, sharesChordIntentionally } from './shortcuts';

type Overrides = Partial<Record<CommandId, string | null>>;

/** An unset field follows the factory binding. Explicit strings and clears belong to the user. */
export function getEffectiveHotkey(key: CommandId, custom?: Overrides | null): Hotkey | null {
  if (custom === null) return null;
  const configured = custom?.[key];
  if (configured !== undefined) return configured as Hotkey | null;
  const fallback = resolveDefaultHotkey(COMMANDS[key]);
  if (!fallback) return null;
  return userOwnsChord(key, fallback, custom) ? null : fallback as Hotkey;
}

function userOwnsChord(key: CommandId, chord: string, custom?: Overrides | null): boolean {
  const platform = detectShortcutPlatform() === 'mac' ? 'mac' : 'windows';
  // A factory change cannot claim a chord already assigned to another action.
  return !!custom && Object.entries(custom).some(([other, assigned]) =>
    assigned && Object.hasOwn(COMMANDS, other) && !sharesChordIntentionally(key, other) &&
    normalizeHotkey(assigned, platform) === normalizeHotkey(chord, platform));
}

export function effectiveAliases(key: CommandId, custom?: Overrides | null): readonly CommandAlias[] {
  const aliases = COMMANDS[key].aliases;
  if (!aliases || custom === null || custom?.[key] === null) return [];
  return aliases.filter(alias => !userOwnsChord(key, typeof alias === 'string' ? alias : alias.character, custom));
}
