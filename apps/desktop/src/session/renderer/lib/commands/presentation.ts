import { i18n } from '@/i18n';
import { COMMANDS, type CommandId } from '@shared/commands';
import type { SessionMessageKey } from '@renderer/localization/messages';
import { translateSessionMessage } from '@renderer/localization/locale-store';

type Translate = (key: SessionMessageKey) => string;
export function commandPresentation(id: CommandId, translate: Translate = translateSessionMessage) {
  const def = COMMANDS[id];
  const key = def.labelKey;
  return {
    label: key.startsWith('main:') ? i18n.t(key.slice(5), { ns: 'main' }) : translate(key as SessionMessageKey),
    description: translate(def.descriptionKey as SessionMessageKey),
    category: translate(`commands.category.${def.category.replaceAll(' ', '')}` as SessionMessageKey),
  };
}
