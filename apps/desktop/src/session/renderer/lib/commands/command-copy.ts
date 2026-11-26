import { i18n } from '@/i18n';
import { COMMANDS, type CommandCategory, type CommandId } from '@shared/commands';
import type { SessionMessageKey } from '@renderer/localization/messages';
import { translateSessionMessage } from '@renderer/localization/locale-store';

/**
 * A built-in command's shown words, in the app's language — one reading for the shortcut settings, the cheat sheet
 * and the command palette. A command with a `labelKey` is called what its menu entry is called (`main:` = the shell's
 * catalog); every other one by its `command.<id>` entry.
 */
export function commandLabel(id: CommandId): string {
  const { labelKey } = COMMANDS[id];
  if (labelKey) {
    return labelKey.startsWith('main:')
      ? i18n.t(labelKey.slice(5), { ns: 'main' })
      : translateSessionMessage(labelKey as SessionMessageKey);
  }
  return translateSessionMessage(`command.${id}` as SessionMessageKey);
}

export function commandDescription(id: CommandId): string {
  return translateSessionMessage(`commandHelp.${id}` as SessionMessageKey);
}

const CATEGORY_KEYS: Record<CommandCategory, SessionMessageKey> = {
  Navigation: 'keyboard.categoryNavigation',
  'Task View': 'keyboard.categoryTaskView',
  'Tab Navigation': 'keyboard.tabNavigation',
  View: 'keyboard.categoryView',
};

export function commandCategoryLabel(category: CommandCategory): string {
  return translateSessionMessage(CATEGORY_KEYS[category]);
}
