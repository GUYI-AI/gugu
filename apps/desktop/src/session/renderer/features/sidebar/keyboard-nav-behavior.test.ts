import { describe, expect, it } from 'vitest';
import { COMMANDS, type CommandId } from '@shared/commands';
import { INTENTIONALLY_SHARED_CHORDS, resolveDefaultHotkey, type ShortcutPlatform } from '@shared/shortcuts';
import {
  isTerminalExitChord,
  SESSION_NAV_SHORTCUT_KEYS,
  sessionNavShortcutFor,
  type SessionNavContext,
  type SessionNavHotkeys,
  type SessionNavKeyEvent,
} from './session-nav-keymap';

/**
 * behavior session-page「键盘导航」, written as a table: which command a key resolves to, per layer.
 * The table is the contract the shortcut refactor must keep; only `resolve` below changes with the
 * implementation. Rows that need the real sidebar DOM (moving along the chain, folding, archive twice)
 * live in the browser suite.
 */
type Platform = 'mac' | 'linux';
const shortcutPlatform = (p: Platform): ShortcutPlatform => (p === 'mac' ? 'mac' : 'other');

function defaults(p: Platform, overrides: Partial<Record<CommandId, string | null>> = {}): SessionNavHotkeys {
  const map: SessionNavHotkeys = {};
  for (const id of SESSION_NAV_SHORTCUT_KEYS) {
    map[id] = (id in overrides ? overrides[id] : resolveDefaultHotkey(COMMANDS[id], shortcutPlatform(p))) as never;
  }
  return map;
}

function key(spec: string, extra: Partial<SessionNavKeyEvent> = {}): SessionNavKeyEvent {
  const parts = spec.split('+');
  const k = parts.pop()!;
  const has = (m: string) => parts.includes(m);
  const code = /^[a-z]$/i.test(k) ? `Key${k.toUpperCase()}` : k;
  return {
    key: has('Alt') && /^[a-z]$/i.test(k) ? k.toLowerCase() : k.length === 1 ? k.toLowerCase() : k,
    code,
    metaKey: has('Meta'),
    ctrlKey: has('Control'),
    altKey: has('Alt'),
    shiftKey: has('Shift'),
    isComposing: false,
    ...extra,
  };
}

function resolve(
  event: SessionNavKeyEvent,
  context: SessionNavContext,
  { platform = 'mac', caretAtStart = false, overrides = {} }: { platform?: Platform; caretAtStart?: boolean; overrides?: Partial<Record<CommandId, string | null>> } = {},
) {
  return sessionNavShortcutFor(event, context, defaults(platform, overrides), { platform, caretAtStart: () => caretAtStart });
}

describe('键盘导航: the layer a key belongs to', () => {
  it.each(['composer-empty', 'composer-text'] as const)('N6 ↑↓ in the composer never switch sessions (%s), even when empty', (ctx) => {
    expect(resolve(key('ArrowUp'), ctx)).toBeNull();
    expect(resolve(key('ArrowDown'), ctx)).toBeNull();
  });

  it('N2/N3 in the nav layer → hands focus to the session, ← jumps to the parent', () => {
    expect(resolve(key('ArrowRight'), 'nav')).toBe('session.focusComposerFromSidebar');
    expect(resolve(key('ArrowLeft'), 'nav')).toBe('session.projectHome');
  });

  it.each(['composer-empty', 'composer-text'] as const)('N7 ← leaves the composer only with the caret at the very start (%s)', (ctx) => {
    expect(resolve(key('ArrowLeft'), ctx, { caretAtStart: true })).toBe('session.backToList');
    expect(resolve(key('ArrowLeft'), ctx, { caretAtStart: false })).toBeNull();
  });

  it.each(['nav', 'composer-empty', 'composer-text'] as const)('N8 Esc returns to the nav layer from anywhere (%s)', (ctx) => {
    expect(resolve(key('Escape'), ctx)).toBe('session.leaveComposer');
  });

  it.each(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'Escape', 'Enter'])('N10 mid-composition %s belongs to the input method', (k) => {
    for (const ctx of ['nav', 'composer-empty', 'composer-text'] as const) {
      expect(resolve(key(k, { isComposing: true }), ctx, { caretAtStart: true })).toBeNull();
    }
  });

  it('N16 modified arrows are never session navigation (the task axis owns them)', () => {
    for (const ctx of ['nav', 'composer-empty', 'composer-text'] as const) {
      for (const k of ['Meta+ArrowUp', 'Meta+ArrowDown', 'Meta+ArrowLeft', 'Shift+ArrowLeft', 'Control+ArrowLeft']) {
        expect(resolve(key(k), ctx, { caretAtStart: true })).toBeNull();
      }
    }
  });
});

describe('键盘导航: rename / pin / archive keys', () => {
  it.each(['nav', 'composer-empty', 'composer-text'] as const)('N11 macOS ⌃R renames and ⌃P pins (%s)', (ctx) => {
    expect(resolve(key('Control+r'), ctx)).toBe('session.rename');
    expect(resolve(key('Control+p'), ctx)).toBe('session.pinHighlighted');
  });

  it('N11 Windows/Linux use Alt + the same letter; Ctrl+R / Ctrl+P stay the host\'s', () => {
    expect(resolve(key('Alt+r'), 'nav', { platform: 'linux' })).toBe('session.rename');
    expect(resolve(key('Alt+p'), 'nav', { platform: 'linux' })).toBe('session.pinHighlighted');
    expect(resolve(key('Control+r'), 'nav', { platform: 'linux' })).toBeNull();
    expect(resolve(key('Control+p'), 'nav', { platform: 'linux' })).toBeNull();
  });

  it('N12/N14 ⌃X archives from the nav layer and an empty composer; with text it stays the platform\'s cut', () => {
    expect(resolve(key('Control+x'), 'nav')).toBe('session.archiveHighlighted');
    expect(resolve(key('Control+x'), 'composer-empty')).toBe('session.archiveHighlighted');
    expect(resolve(key('Control+x'), 'composer-text')).toBeNull();
    expect(resolve(key('Control+x'), 'nav', { platform: 'linux' })).toBeNull();
    expect(resolve(key('Alt+x'), 'nav', { platform: 'linux' })).toBe('session.archiveHighlighted');
  });
});

describe('键盘导航: the terminal gives back one key', () => {
  const exit = resolveDefaultHotkey(COMMANDS['session.leaveTerminal'])!;
  it('N17 ⌥← leaves the terminal; ←, ⇧←, ⌃←, ⌘← stay the TUI\'s', () => {
    expect(isTerminalExitChord(key('Alt+ArrowLeft'), exit as never, { platform: 'mac' })).toBe(true);
    for (const k of ['ArrowLeft', 'Shift+ArrowLeft', 'Control+ArrowLeft', 'Meta+ArrowLeft', 'Control+r', 'ArrowUp']) {
      expect(isTerminalExitChord(key(k), exit as never, { platform: 'mac' })).toBe(false);
    }
  });
  it('N17 a modal over the terminal, an IME composition, or a cleared binding all keep the key', () => {
    expect(isTerminalExitChord(key('Alt+ArrowLeft'), exit as never, { platform: 'mac', modalOpen: true })).toBe(false);
    expect(isTerminalExitChord(key('Alt+ArrowLeft', { isComposing: true }), exit as never, { platform: 'mac' })).toBe(false);
    expect(isTerminalExitChord(key('Alt+ArrowLeft'), null, { platform: 'mac' })).toBe(false);
  });
});

describe('键盘导航: bindings come from settings', () => {
  it('N19 a rebound key works at once and the old one stops; unassigned = off', () => {
    expect(resolve(key('Control+e'), 'nav', { overrides: { 'session.rename': 'Control+E' } })).toBe('session.rename');
    expect(resolve(key('Control+r'), 'nav', { overrides: { 'session.rename': 'Control+E' } })).toBeNull();
    expect(resolve(key('Control+r'), 'nav', { overrides: { 'session.rename': null } })).toBeNull();
  });

  it('N20 the two ← defaults split by layer: the parent jump only in nav, the composer exit only in the composer', () => {
    for (const caretAtStart of [true, false]) {
      expect(resolve(key('ArrowLeft'), 'nav', { caretAtStart })).toBe('session.projectHome');
      for (const ctx of ['composer-empty', 'composer-text'] as const) {
        expect(resolve(key('ArrowLeft'), ctx, { caretAtStart })).toBe(caretAtStart ? 'session.backToList' : null);
      }
    }
  });

  it.each(['mac', 'other'] as const)('N21 no two factory defaults share a chord on %s unless registered as shared', (platform) => {
    const byChord = new Map<string, CommandId[]>();
    for (const id of Object.keys(COMMANDS) as CommandId[]) {
      const chord = resolveDefaultHotkey(COMMANDS[id], platform);
      if (chord) byChord.set(chord, [...(byChord.get(chord) ?? []), id]);
    }
    const shared = (a: CommandId, b: CommandId) => INTENTIONALLY_SHARED_CHORDS.some(({ keys }) => keys.includes(a) && keys.includes(b));
    for (const [chord, ids] of byChord) {
      for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
        expect(shared(ids[i]!, ids[j]!), `${chord}: ${ids[i]} vs ${ids[j]}`).toBe(true);
      }
    }
  });
});
