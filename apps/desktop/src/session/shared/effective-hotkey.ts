import { normalizeHotkey, type Hotkey } from '@tanstack/hotkeys';
import { COMMANDS, type CommandAlias, type CommandId } from './commands';
import { detectShortcutPlatform, resolveDefaultHotkey, sharesChordIntentionally } from './shortcuts';

type Overrides = Partial<Record<CommandId, string | null>>;
type Owners = Map<string, CommandId[]>;
const defaults: Overrides = {};
const ids = Object.keys(COMMANDS) as CommandId[];

function chordKey(chord: string): string {
  return normalizeHotkey(chord, detectShortcutPlatform() === 'mac' ? 'mac' : 'windows');
}

export function sameShortcut(a: string | null, b: string | null): boolean {
  return a !== null && b !== null && chordKey(a) === chordKey(b);
}

function addOwner(index: Owners, chord: string, id: CommandId): void {
  const key = chordKey(chord);
  const owners = index.get(key);
  if (owners) owners.push(id);
  else index.set(key, [id]);
}

function otherOwner(index: Owners, id: CommandId, chord: string): CommandId | undefined {
  return index.get(chordKey(chord))?.find(other => other !== id && !sharesChordIntentionally(id, other));
}

/** Resolve a settings snapshot once. The recorder and dispatchers use the same normalized chords. */
function resolveBindings(custom: Overrides) {
  const assigned: Owners = new Map();
  const active: Owners = new Map();
  const primary = new Map<CommandId, Hotkey>();
  const aliases = new Map<CommandId, readonly CommandAlias[]>();
  const displaced = new Map<CommandId, CommandId>();

  for (const id of ids) {
    const chord = custom[id];
    if (chord && !COMMANDS[id].systemShortcut) addOwner(assigned, chord, id);
  }
  for (const id of ids) {
    const def = COMMANDS[id];
    if (def.systemShortcut) continue;
    const fallback = resolveDefaultHotkey(def);
    const owner = fallback && otherOwner(assigned, id, fallback);
    if (owner) displaced.set(id, owner);
    if (custom[id] === null) continue;
    const chord = custom[id] ?? (owner ? undefined : fallback);
    if (chord) {
      primary.set(id, chord as Hotkey);
      addOwner(active, chord, id);
    }
    const available = def.aliases?.filter(alias => {
      const key = typeof alias === 'string' ? alias : alias.character;
      if (otherOwner(assigned, id, key)) return false;
      addOwner(active, key, id);
      return true;
    });
    if (available?.length) aliases.set(id, available);
  }
  return { primary, aliases, active, displaced };
}

const cache = {
  mac: new WeakMap<Overrides, ReturnType<typeof resolveBindings>>(),
  other: new WeakMap<Overrides, ReturnType<typeof resolveBindings>>(),
};
function bindings(custom: Overrides = defaults) {
  const forPlatform = cache[detectShortcutPlatform()];
  const existing = forPlatform.get(custom);
  if (existing) return existing;
  const result = resolveBindings(custom);
  forPlatform.set(custom, result);
  return result;
}

export function getEffectiveHotkey(id: CommandId, custom?: Overrides | null): Hotkey | null {
  return custom === null ? null : bindings(custom).primary.get(id) ?? null;
}

export function effectiveAliases(id: CommandId, custom?: Overrides | null): readonly CommandAlias[] {
  return custom === null ? [] : bindings(custom).aliases.get(id) ?? [];
}

export function shortcutConflict(id: CommandId, chord: string, custom: Overrides, quickChatAccelerator?: string): CommandId | undefined {
  if (quickChatAccelerator && sameShortcut(chord, quickChatAccelerator)) return 'app.quickChat';
  return otherOwner(bindings(custom).active, id, chord);
}

export function defaultShortcutOwner(id: CommandId, custom: Overrides): CommandId | undefined {
  return bindings(custom).displaced.get(id);
}
