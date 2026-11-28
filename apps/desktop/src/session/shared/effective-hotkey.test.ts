import { describe, expect, it } from 'vitest';
import { COMMANDS, type CommandId } from './commands';
import { effectiveAliases, getEffectiveHotkey } from './effective-hotkey';

describe('saved keyboard assignments across factory binding changes', () => {
  const editable = (Object.keys(COMMANDS) as CommandId[]).filter(id => !COMMANDS[id].systemShortcut);
  it.each(editable)('keeps an assigned or cleared %s', id => {
    expect(getEffectiveHotkey(id, { [id]: 'Alt+F10' })).toBe('Alt+F10');
    expect(getEffectiveHotkey(id, { [id]: null })).toBeNull();
  });

  it('keeps a historical in-app assignment from overriding the system Quick Chat shortcut', () => {
    expect(getEffectiveHotkey('app.quickChat', { 'app.quickChat': 'Alt+F10' })).toBeNull();
  });

  it('only advertises and accepts compatibility keys when the user left them available', () => {
    expect(effectiveAliases('app.commandPalette', {})).toContain('Mod+P');
    expect(effectiveAliases('app.quickSwitcher', {})).toContain('Mod+O');
    expect(effectiveAliases('app.commandPalette', { 'app.commandPalette': null })).toEqual([]);
    expect(effectiveAliases('app.quickSwitcher', { 'app.quickSwitcher': 'Alt+K' })).toContain('Mod+O');
    expect(effectiveAliases('app.commandPalette', { 'app.library': 'Mod+P' })).toEqual([]);
  });

  it('leaves a newly assigned factory chord with its previous owner', () => {
    const saved = { 'app.library': 'Mod+K', 'session.tab2': 'Mod+2', 'session.focusComposer': 'Shift+Escape' };
    expect(getEffectiveHotkey('app.quickSwitcher', saved)).toBeNull();
    expect(getEffectiveHotkey('chat.select2', saved)).toBeNull();
    expect(getEffectiveHotkey('chat.markAllRead', saved)).toBeNull();
    expect(getEffectiveHotkey('session.tab2', saved)).toBe('Mod+2');
    expect(getEffectiveHotkey('app.commandPalette', saved)).toBe('Mod+Shift+P');
  });
});
