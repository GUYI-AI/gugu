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

it.each(['Alt+Shift+Space', 'Control+Alt+Space', 'Control+Shift+F11'])('reserves the registered system shortcut %s even with a stale Quick Chat override', systemChord => {
  const custom = { 'app.quickChat': 'Alt+J' };
  expect(shortcutConflict('app.library', systemChord, custom, systemChord)).toBe('app.quickChat');
  expect(shortcutConflict('app.library', systemChord, custom)).toBeUndefined();
  expect(shortcutConflict('app.library', 'Alt+J', custom, systemChord)).toBeUndefined();
});

it('reports normalized primary and alias conflicts and identifies a displaced default', () => {
  expect(shortcutConflict('app.settings', 'Ctrl+Tab', {})).toBe('session.tabNext');
  const overrides = { 'app.library': 'Mod+,' };
  expect(defaultShortcutOwner('app.settings', overrides)).toBe('app.library');
  expect(shortcutConflict('app.library', 'Mod+,', overrides)).toBeUndefined();
});
