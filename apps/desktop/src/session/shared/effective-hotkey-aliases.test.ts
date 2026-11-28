import { expect, it } from 'vitest';
import { defaultShortcutOwner, shortcutConflict, effectiveAliases } from './effective-hotkey';

it('keeps aliases with a rebound command and disables them with a cleared command', () => {
  const help = 'app.showKeyboardShortcuts';
  expect(effectiveAliases(help, { [help]: 'Alt+F10' })).toEqual([{ character: '?', region: 'navigation' }]);
  expect(effectiveAliases(help, { [help]: null })).toEqual([]);
  expect(effectiveAliases('session.tabNext', { 'session.tabNext': 'Alt+F10' })).toEqual(['Control+Tab']);
  expect(effectiveAliases('session.tabNext', { 'session.tabNext': null })).toEqual([]);
  expect(effectiveAliases('session.tabNext', { 'app.library': 'Control+Tab' })).toEqual([]);
});

it('reports normalized primary and alias conflicts and identifies a displaced default', () => {
  expect(shortcutConflict('app.settings', 'Ctrl+Tab', {})).toBe('session.tabNext');
  const overrides = { 'app.library': 'Mod+,' };
  expect(defaultShortcutOwner('app.settings', overrides)).toBe('app.library');
  expect(shortcutConflict('app.library', 'Mod+,', overrides)).toBeUndefined();
});
