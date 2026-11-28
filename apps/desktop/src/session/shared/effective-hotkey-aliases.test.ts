import { expect, it } from 'vitest';
import { effectiveAliases } from './effective-hotkey';

it('keeps aliases with a rebound command and disables them with a cleared command', () => {
  const help = 'app.showKeyboardShortcuts';
  expect(effectiveAliases(help, { [help]: 'Alt+F10' })).toEqual([{ character: '?', region: 'navigation' }]);
  expect(effectiveAliases(help, { [help]: null })).toEqual([]);
  expect(effectiveAliases('session.tabNext', { 'session.tabNext': 'Alt+F10' })).toEqual(['Control+Tab']);
  expect(effectiveAliases('session.tabNext', { 'session.tabNext': null })).toEqual([]);
  expect(effectiveAliases('session.tabNext', { 'app.library': 'Control+Tab' })).toEqual([]);
});
