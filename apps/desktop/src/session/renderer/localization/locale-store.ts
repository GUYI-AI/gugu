import {
  getLocaleSnapshot,
  i18n,
  registerLocaleNamespace,
  subscribeLocale,
} from '@/i18n/runtime';
import type { SupportedLocale } from '@/i18n/locale';
import { enUSMessages, type SessionMessageKey, zhCNMessages } from './messages';

export type SessionLocale = SupportedLocale;
export type SessionMessageValues = Readonly<Record<string, string | number>>;

let registered = false;

export function registerSessionLocaleResources(): void {
  if (registered) return;
  registerLocaleNamespace('session', {
    'zh-CN': zhCNMessages,
    'en-US': enUSMessages,
  });
  registered = true;
}

export function getSessionLocaleSnapshot() {
  return getLocaleSnapshot();
}

export const subscribeSessionLocale = subscribeLocale;

export function translateSessionMessage(
  messageKey: SessionMessageKey | string,
  values: SessionMessageValues = {}
): string {
  registerSessionLocaleResources();
  const options = {
    ns: 'session',
    ...values,
    interpolation: { prefix: '{', suffix: '}' },
  } as const;
  // One resolution, not an `exists` and then a `t`: rows translate on every render. A key that resolves to nothing
  // comes back as the marker and still fails loudly.
  const text = i18n.t(messageKey, { ...options, defaultValue: MISSING_SESSION_TRANSLATION });
  if (text === MISSING_SESSION_TRANSLATION) {
    throw new Error(
      `Missing session translation: ${getLocaleSnapshot().resolvedLocale}:${messageKey}`
    );
  }
  return text;
}
const MISSING_SESSION_TRANSLATION = '\u0000missing-session-translation';
