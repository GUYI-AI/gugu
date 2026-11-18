import type { Hotkey } from '@tanstack/react-hotkeys';
import { describe, expect, it } from 'vitest';
import { COMMANDS } from '@shared/commands';
import { resolveDefaultHotkey } from '@shared/shortcuts';
import {
  deferToDefaultPrevented,
  isTerminalExitChord,
  sessionNavShortcutFor,
  type SessionNavHotkeys,
  type SessionNavKeyEvent,
} from './session-nav-keymap';

const DEFAULTS: SessionNavHotkeys = {
  'session.archiveHighlighted': 'Control+X',
};

function key(k: string, overrides: Partial<SessionNavKeyEvent> = {}): SessionNavKeyEvent {
  return {
    key: k,
    code: k.length === 1 ? `Key${k.toUpperCase()}` : k,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    isComposing: false,
    ...overrides,
  };
}

describe('session navigation keymap', () => {
  // #2548 the rows ⌘↑/⌘↓ switch between are the one list's, and the chat list walks them itself (ChatListPanel).
  it('leaves the arrows, bare or with ⌘, to whoever walks the list', () => {
    for (const context of ['nav', 'composer-empty', 'composer-text'] as const) {
      const at = (event: SessionNavKeyEvent) =>
        sessionNavShortcutFor(event, context, DEFAULTS, { platform: 'mac' });

      expect(at(key('ArrowUp'))).toBeNull();
      expect(at(key('ArrowDown'))).toBeNull();
      expect(at(key('ArrowUp', { metaKey: true }))).toBeNull();
      expect(at(key('ArrowDown', { metaKey: true }))).toBeNull();
    }
  });

  it('does not take a chord while an IME is composing', () => {
    const composing = key('x', { ctrlKey: true, isComposing: true });
    expect(sessionNavShortcutFor(composing, 'composer-empty', DEFAULTS, { platform: 'mac' })).toBeNull();
    expect(
      sessionNavShortcutFor({ ...composing, isComposing: false }, 'composer-empty', DEFAULTS, {
        platform: 'mac',
      }),
    ).toBe('session.archiveHighlighted');
  });

  it('defers popup-owned arrows but keeps Escape available in a composer', () => {
    expect(deferToDefaultPrevented('ArrowUp', 'composer-text')).toBe(true);
    expect(deferToDefaultPrevented('ArrowDown', 'composer-empty')).toBe(true);
    expect(deferToDefaultPrevented('Escape', 'composer-text')).toBe(false);
    expect(deferToDefaultPrevented('Escape', 'nav')).toBe(true);
  });
});

describe('terminal exit chord', () => {
  const MAC_CHORD = resolveDefaultHotkey(COMMANDS['session.leaveTerminal'], 'mac') as Hotkey;

  it('claims only its chord and stands down for modal, IME, or cleared ownership', () => {
    const pressed = key('ArrowLeft', { altKey: true });
    expect(isTerminalExitChord(pressed, MAC_CHORD, { platform: 'mac' })).toBe(true);
    expect(isTerminalExitChord(pressed, MAC_CHORD, { platform: 'mac', modalOpen: true })).toBe(false);
    expect(
      isTerminalExitChord({ ...pressed, isComposing: true }, MAC_CHORD, { platform: 'mac' }),
    ).toBe(false);
    expect(isTerminalExitChord(pressed, null, { platform: 'mac' })).toBe(false);
    expect(isTerminalExitChord(key('ArrowRight', { altKey: true }), MAC_CHORD, { platform: 'mac' })).toBe(
      false,
    );
  });
});
