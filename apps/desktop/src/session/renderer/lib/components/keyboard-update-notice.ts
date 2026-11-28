import { readInterface, writeInterface } from '@/lib/viewStateTable';
import type { CommandId } from '@shared/commands';
import { getEffectiveHotkey, sameShortcut } from '@shared/effective-hotkey';

type Overrides = Partial<Record<CommandId, string | null>>;

// These are the previous assignments that lost a chord. The former palette keys still work as aliases.
const formerDefaults: Partial<Record<CommandId, string>> = {
  'app.library': 'Mod+L',
  'app.newProject': 'Mod+Shift+N',
  'session.focusSidebar': 'Mod+0',
  'session.focusComposer': 'Shift+Escape',
  'chat.scrollToTop': 'Mod+ArrowUp',
  'chat.scrollToBottom': 'Mod+ArrowDown',
  'app.zenMode': 'Control+Z',
};
for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 9] as const) formerDefaults[`session.tab${n}`] = `Mod+${n}`;

export function takeKeyboardUpdateNotice(account: string | null, previousAccount: string | null, keyboard: Overrides | null): boolean {
  if (!account || readInterface<boolean>('keyboard-defaults-update', account)) return false;
  if (account === previousAccount && !keyboard) return false;
  writeInterface('keyboard-defaults-update', true, account);
  if (account !== previousAccount || !keyboard) return false;
  const assigned = Object.values(keyboard).filter((value): value is string => typeof value === 'string');
  return (Object.entries(formerDefaults) as [CommandId, string][]).some(([id, former]) =>
    keyboard[id] === undefined && !sameShortcut(getEffectiveHotkey(id, keyboard), former) &&
    !assigned.some(chord => sameShortcut(chord, former)));
}
