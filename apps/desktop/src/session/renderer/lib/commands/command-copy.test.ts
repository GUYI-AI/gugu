import { afterEach, describe, expect, it } from 'vitest';
import { i18n } from '@/i18n';
import { COMMANDS, type CommandId } from '@shared/commands';
import { commandCategoryLabel, commandDescription, commandLabel } from './command-copy';

const ids = Object.keys(COMMANDS) as CommandId[];

describe('built-in command copy', () => {
  afterEach(async () => {
    await i18n.changeLanguage('zh-CN');
  });

  it('reads the English words from the command catalog', async () => {
    await i18n.changeLanguage('en-US');
    for (const id of ids) {
      if (!COMMANDS[id].labelKey) expect(commandLabel(id)).toBe(COMMANDS[id].label);
      expect(commandDescription(id)).toBe(COMMANDS[id].description);
    }
    expect(commandCategoryLabel('Navigation')).toBe('Navigation');
  });

  // The shortcut settings in a Chinese app listed NAVIGATION / Open Settings / Open application settings.
  it('names every command, its help text and its group in Chinese', async () => {
    await i18n.changeLanguage('zh-CN');
    for (const id of ids) {
      expect(commandLabel(id)).not.toBe(COMMANDS[id].label);
      expect(commandDescription(id)).toMatch(/[一-鿿]/);
    }
    expect(commandLabel('app.settings')).toBe('设置');
    expect(commandLabel('app.toggleTheme')).toBe('切换主题');
    for (const category of ['Navigation', 'Task View', 'Tab Navigation', 'View'] as const) {
      expect(commandCategoryLabel(category)).toMatch(/[一-鿿]/);
    }
  });
});
