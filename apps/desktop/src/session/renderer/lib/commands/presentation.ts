import { i18n } from '@/i18n';
import { COMMANDS, type CommandId } from '@shared/commands';
import type { SessionMessageKey } from '@renderer/localization/messages';
import { translateSessionMessage } from '@renderer/localization/locale-store';
import type { AppCommand } from './types';

type Translate = (key: SessionMessageKey) => string;
export function commandPresentation(id: CommandId, translate: Translate = translateSessionMessage,
  live?: Pick<AppCommand, 'labelKey' | 'descriptionKey'>) {
  const def = COMMANDS[id];
  const key = live?.labelKey ?? def.labelKey;
  return {
    label: key.startsWith('main:') ? i18n.t(key.slice(5), { ns: 'main' }) : translate(key as SessionMessageKey),
    description: translate((live?.descriptionKey ?? def.descriptionKey) as SessionMessageKey),
    category: translate(`commands.category.${def.category.replaceAll(' ', '')}` as SessionMessageKey),
  };
}

/** Keep the live provider command: presentation must not replace its current handler. */
export function paletteCommandPresentation(command: AppCommand, translate: Translate = translateSessionMessage) {
  const text = Object.hasOwn(COMMANDS, command.id)
    ? commandPresentation(command.id as CommandId, translate, command)
    : undefined;
  return { command, title: text?.label ?? command.label ?? command.id,
    description: text?.description ?? command.description ?? '' };
}
