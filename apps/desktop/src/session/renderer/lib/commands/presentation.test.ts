import { afterEach, describe, expect, it } from 'vitest';
import { i18n, setLocalePreference } from '@/i18n';
import '@/i18n/registerMainCatalog';
import { COMMANDS, type CommandId } from '@shared/commands';
import { enUSMessages, zhCNMessages } from '@renderer/localization/messages';
import { commandPresentation } from './presentation';

const previousLocale = i18n.language === 'en-US' ? 'en-US' : 'zh-CN';
afterEach(() => setLocalePreference(previousLocale));

for (const [locale, messages] of [['en-US', enUSMessages], ['zh-CN', zhCNMessages]] as const) {
  describe(`${locale} built-in command chrome`, () => {
    it('has labels, descriptions and categories for every stable command ID', () => {
      setLocalePreference(locale);
      const translate = (key: keyof typeof enUSMessages) => {
        expect(messages[key], key).toBeTruthy();
        return messages[key];
      };
      for (const id of Object.keys(COMMANDS) as CommandId[]) {
        const text = commandPresentation(id, translate);
        expect(text.label, id).toBeTruthy();
        expect(text.label, id).not.toMatch(/^(?:commands|shell)\./);
        expect(text.description, id).toBeTruthy();
        expect(text.category, id).toBeTruthy();
        expect(text.label, id).not.toMatch(/\bTask\b|任务/);
        expect(text.description, id).not.toMatch(/\btask\b|任务/);
      }
    });
  });
}
