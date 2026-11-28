import { registeredQuickChatAccelerator } from '@/lib/quickChatIpc';
import { quickChatShortcutLabel, useQuickChatState } from '@/components/assistant/useQuickChatState';
import { effectiveAliases } from '@shared/effective-hotkey';
import { promptEditorShortcuts } from '@gugu/session-ui/react/components';
import { commandRegistry } from '@renderer/lib/commands/registry';
import { isCurrentComposerControl } from '@renderer/lib/commands/composer-model-command';
import { getPortalContainer } from '@renderer/lib/portal-container';
import type { CommandAlias } from '@shared/commands';
import type { Hotkey } from '@tanstack/react-hotkeys';
import React, { useState, useMemo } from 'react';
import {
  getEffectiveHotkey,
  type CommandId, useShortcutOverrides } from '@renderer/lib/hooks/useKeyboardShortcuts';
import { COMMANDS, SHORTCUTS_BY_CATEGORY } from '@shared/commands';
import { commandCategoryLabel, commandDescription, commandLabel } from '@renderer/lib/commands/command-copy';
import { type BaseModalProps } from '@renderer/lib/modal/modal-provider';
import { Shortcut } from '@renderer/lib/ui/shortcut';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { cn } from '@renderer/utils/utils';

// ---------------------------------------------------------------------------
// Types & Constants
// ---------------------------------------------------------------------------

type ShortcutEntry = [CommandId, (typeof COMMANDS)[CommandId]];

// ---------------------------------------------------------------------------
// Hotkey → Key ID Parsing
// ---------------------------------------------------------------------------

function parseHotkeyToKeys(hotkey: string): Set<string> {
  const keys = new Set<string>();
  const parts = hotkey.split('+');

  for (const part of parts) {
    switch (part) {
      case 'Mod':
      case 'Meta':
        keys.add('meta');
        break;
      case 'Shift':
        keys.add('shift');
        break;
      case 'Alt':
        keys.add('alt');
        break;
      case 'Control':
        keys.add('control');
        break;
      case 'ArrowUp':
        keys.add('arrowup');
        break;
      case 'ArrowDown':
        keys.add('arrowdown');
        break;
      case 'ArrowLeft':
        keys.add('arrowleft');
        break;
      case 'ArrowRight':
        keys.add('arrowright');
        break;
      case 'Backspace':
        keys.add('backspace');
        break;
      case 'Enter':
        keys.add('enter');
        break;
      case 'Tab':
        keys.add('tab');
        break;
      case 'Escape':
        keys.add('escape');
        break;
      default:
        keys.add(part.toLowerCase());
        break;
    }
  }

  return keys;
}

// ---------------------------------------------------------------------------
// Shortcut Data Helpers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Mac Keyboard SVG
// ---------------------------------------------------------------------------

interface KeyDef {
  id: string;
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

const KEY_H = 40;
const GAP = 2;
const STD_W = 44;

function key(id: string, label: string, x: number, y: number, w: number = STD_W): KeyDef {
  return { id, label, x, y, w, h: KEY_H };
}

function buildRow(
  y: number,
  keys: Array<{ id: string; label: string; w?: number }>
): KeyDef[] {
  const result: KeyDef[] = [];
  let x = 0;
  for (const k of keys) {
    const w = k.w ?? STD_W;
    result.push(key(k.id, k.label, x, y, w));
    x += w + GAP;
  }
  return result;
}

const ROW_1 = buildRow(0, [
  { id: '`', label: '`' },
  { id: '1', label: '1' },
  { id: '2', label: '2' },
  { id: '3', label: '3' },
  { id: '4', label: '4' },
  { id: '5', label: '5' },
  { id: '6', label: '6' },
  { id: '7', label: '7' },
  { id: '8', label: '8' },
  { id: '9', label: '9' },
  { id: '0', label: '0' },
  { id: '-', label: '-' },
  { id: '=', label: '=' },
  { id: 'backspace', label: '⌫', w: 68 },
]);

const ROW_2 = buildRow(46, [
  { id: 'tab', label: 'Tab', w: 60 },
  { id: 'q', label: 'Q' },
  { id: 'w', label: 'W' },
  { id: 'e', label: 'E' },
  { id: 'r', label: 'R' },
  { id: 't', label: 'T' },
  { id: 'y', label: 'Y' },
  { id: 'u', label: 'U' },
  { id: 'i', label: 'I' },
  { id: 'o', label: 'O' },
  { id: 'p', label: 'P' },
  { id: '[', label: '[' },
  { id: ']', label: ']' },
  { id: '\\', label: '\\', w: 52 },
]);

const ROW_3 = buildRow(92, [
  { id: 'capslock', label: 'Caps', w: 70 },
  { id: 'a', label: 'A' },
  { id: 's', label: 'S' },
  { id: 'd', label: 'D' },
  { id: 'f', label: 'F' },
  { id: 'g', label: 'G' },
  { id: 'h', label: 'H' },
  { id: 'j', label: 'J' },
  { id: 'k', label: 'K' },
  { id: 'l', label: 'L' },
  { id: ';', label: ';' },
  { id: "'", label: "'" },
  { id: 'enter', label: 'Enter', w: 88 },
]);

const ROW_4 = buildRow(138, [
  { id: 'shift', label: '⇧', w: 88 },
  { id: 'z', label: 'Z' },
  { id: 'x', label: 'X' },
  { id: 'c', label: 'C' },
  { id: 'v', label: 'V' },
  { id: 'b', label: 'B' },
  { id: 'n', label: 'N' },
  { id: 'm', label: 'M' },
  { id: ',', label: ',' },
  { id: '.', label: '.' },
  { id: '/', label: '/' },
  { id: 'shift-right', label: '⇧', w: 116 },
]);

const ROW_5 = buildRow(184, [
  { id: 'fn', label: 'fn' },
  { id: 'control', label: '⌃' },
  { id: 'alt', label: '⌥' },
  { id: 'meta', label: '⌘', w: 56 },
  { id: 'space', label: '', w: 228 },
  { id: 'meta-right', label: '⌘', w: 56 },
  { id: 'alt-right', label: '⌥' },
  { id: 'arrowleft', label: '←' },
  { id: 'arrowup', label: '↑', w: 44 },
  { id: 'arrowright', label: '→' },
]);

// Arrow up/down share a half-height key area. We handle this specially.
const ARROW_DOWN: KeyDef = (() => {
  const arrowUp = ROW_5.find((k) => k.id === 'arrowup')!;
  return {
    id: 'arrowdown',
    label: '↓',
    x: arrowUp.x,
    y: arrowUp.y + 21,
    w: arrowUp.w,
    h: 19,
  };
})();

// Adjust arrowup to be half-height
const ARROW_UP_ADJUSTED: KeyDef = (() => {
  const arrowUp = ROW_5.find((k) => k.id === 'arrowup')!;
  return { ...arrowUp, h: 19 };
})();

const ALL_KEYS: KeyDef[] = [
  ...ROW_1,
  ...ROW_2,
  ...ROW_3,
  ...ROW_4,
  ...ROW_5.filter((k) => k.id !== 'arrowup'),
  ARROW_UP_ADJUSTED,
  ARROW_DOWN,
];

// For highlighting, "shift-right" should also match "shift", etc.
function keyMatchesHighlight(keyId: string, highlighted: Set<string>): boolean {
  if (highlighted.has(keyId)) return true;
  if (keyId === 'shift-right' && highlighted.has('shift')) return true;
  if (keyId === 'meta-right' && highlighted.has('meta')) return true;
  if (keyId === 'alt-right' && highlighted.has('alt')) return true;
  return false;
}

interface MacKeyboardProps {
  highlightedKeys: Set<string>;
}

const MacKeyboard: React.FC<MacKeyboardProps> = React.memo(({ highlightedKeys }) => {
  const maxX = Math.max(...ALL_KEYS.map((k) => k.x + k.w));
  const maxY = Math.max(...ALL_KEYS.map((k) => k.y + k.h));

  return (
    <svg
      viewBox={`0 0 ${maxX} ${maxY}`}
      className="w-full select-none"
      aria-hidden="true"
    >
      {ALL_KEYS.map((k) => {
        const active = keyMatchesHighlight(k.id, highlightedKeys);
        return (
          <g key={`${k.id}-${k.x}-${k.y}`} data-key={k.id}>
            <rect
              x={k.x}
              y={k.y}
              width={k.w}
              height={k.h}
              rx={6}
              style={{
                fill: active ? 'var(--live)' : 'var(--neutral-3, var(--background-2))',
                stroke: active ? 'var(--live)' : 'var(--neutral-6, var(--border-1))',
                strokeWidth: 1,
                // @@@task-fusion (#2802) — 并入本体后受咕咕动效 token 门约束(ui-state-debt-check):
                // ❌ 魔数时长。⚠️ 不能带 fallback(`var(--dur-fast, 120ms)` 里的数字照样被判债务)。
                transition: 'fill var(--dur-fast), stroke var(--dur-fast)',
                opacity: active ? 0.9 : 1,
              }}
            />
            <text
              x={k.x + k.w / 2}
              y={k.y + k.h / 2}
              textAnchor="middle"
              dominantBaseline="central"
              style={{
                fill: active
                  ? 'var(--neutral-12, var(--foreground))'
                  : 'var(--neutral-11, var(--foreground-muted))',
                fontSize: k.h < 25 ? '9px' : '11px',
                fontFamily: 'system-ui, -apple-system, sans-serif',
                fontWeight: 500,
                transition: 'fill var(--dur-fast)',
                pointerEvents: 'none',
              }}
            >
              {k.label}
            </text>
          </g>
        );
      })}
    </svg>
  );
});

MacKeyboard.displayName = 'MacKeyboard';

// ---------------------------------------------------------------------------
// Shortcut Row
// ---------------------------------------------------------------------------

interface ShortcutRowProps {
  shortcutKey: CommandId;
  label: string;
  hotkeys: readonly CommandAlias[];
  systemBinding?: string;
  emptyLabel: string;
  isActive: boolean;
  onActivate: (key: CommandId | null) => void;
}

const ShortcutRow: React.FC<ShortcutRowProps> = ({
  shortcutKey,
  label,
  hotkeys,
  systemBinding,
  emptyLabel,
  isActive,
  onActivate,
}) => {
  return (
    <div
      onMouseEnter={() => onActivate(shortcutKey)}
      onMouseLeave={() => onActivate(null)}
      onClick={() => onActivate(isActive ? null : shortcutKey)}
      className={cn(
        'flex cursor-pointer items-center justify-between gap-2 rounded-md px-2 py-1 transition-colors',
        isActive
          ? 'bg-row-selected'
          : 'hover:bg-row-hover'
      )}
    >
      <span className="truncate text-[length:var(--font-body)] text-foreground">{label}</span>
      <span className="flex flex-wrap justify-end gap-2">
        {hotkeys.map(binding => typeof binding === 'string'
          ? <Shortcut key={binding} hotkey={binding as Hotkey} variant="keycaps" />
          : <Shortcut key={binding.character} hotkey={binding.character as Hotkey} variant="keycaps" />)}
        {systemBinding && <kbd>{systemBinding}</kbd>}
        {!hotkeys.length && !systemBinding && emptyLabel}
      </span>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Category Section (single category, vertical list)
// ---------------------------------------------------------------------------

interface CategorySectionProps {
  /** @@@lookup value — COMMANDS 的 category 是数据键,展示用 categoryLabel。 */
  category: string;
  categoryLabel: string;
  entries: ShortcutEntry[];
  quickChatBinding?: string;
  keyboard: Record<string, string | null> | null;
  activeShortcut: CommandId | null;
  onActivate: (key: CommandId | null) => void;
}

const CategorySection: React.FC<CategorySectionProps> = ({
  category,
  categoryLabel,
  entries,
  quickChatBinding,
  keyboard,
  activeShortcut,
  onActivate,
}) => {
  const { translate } = useSessionMessages();
  if (!entries.length) return null;
  return (
    <div>
      <div className="mb-1.5 flex items-center gap-1.5 px-2">
        <span
          data-shortcut-category={category}
          className="text-micro font-semibold uppercase tracking-wider text-foreground-muted"
        >
          {categoryLabel}
        </span>
        <span className="text-micro text-foreground-muted/60">{entries.length}</span>
      </div>
      <div className="flex flex-col gap-0.5">
        {entries.map(([key]) => {
          const hotkey = getEffectiveHotkey(key, keyboard);
          const aliases = effectiveAliases(key, keyboard);
          return (
            <ShortcutRow
              key={key}
              shortcutKey={key}
              label={commandLabel(key)}
              systemBinding={key === 'app.quickChat' ? quickChatBinding : undefined}
              hotkeys={hotkey ? [hotkey, ...aliases] : aliases}
              emptyLabel={translate('keyboard.unassignedValue')}
              isActive={activeShortcut === key}
              onActivate={onActivate}
            />
          );
        })}
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------

export const KeyboardShortcutsCheatSheet: React.FC<BaseModalProps> = ({ onClose }) => {
  const keyboard = useShortcutOverrides();
  const { available, reading: quickChat } = useQuickChatState();
  const showQuickChat = available && quickChat.state === 'value' && quickChat.value.supported;
  const quickChatBinding = showQuickChat && registeredQuickChatAccelerator(quickChat.value) ? quickChatShortcutLabel(quickChat.value) : undefined;
  const [editorShortcuts] = useState(() => {
    const roots = new Set<ParentNode>([document, (getPortalContainer()?.getRootNode() ?? document) as ParentNode]);
    const editors = [...roots].flatMap(root => Array.from(root.querySelectorAll<HTMLElement>('[contenteditable][data-prompt-history]')))
      .filter(editor => isCurrentComposerControl(editor, commandRegistry.contextElement));
    const editor = editors.length === 1 ? editors[0] : editors.find(el => el.contains(commandRegistry.contextElement));
    return editor ? promptEditorShortcuts(editor.enterKeyHint === 'send' ? 'submit' : 'newline', editor.dataset.promptHistory === 'enabled') : [];
  });
  const [activeShortcut, setActiveShortcut] = useState<CommandId | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const { translate } = useSessionMessages();

  const highlightedKeys = useMemo(() => {
    if (!activeShortcut) return new Set<string>();
    const hotkey = getEffectiveHotkey(activeShortcut, keyboard);
    if (!hotkey) return new Set<string>();
    return parseHotkeyToKeys(hotkey);
  }, [activeShortcut, keyboard]);

  const groups = [...SHORTCUTS_BY_CATEGORY].map(([category, entries]) => {
    const query = searchQuery.trim().toLowerCase();
    const group: ShortcutEntry[] = showQuickChat && category === COMMANDS['app.quickChat'].category
      ? [['app.quickChat', COMMANDS['app.quickChat']], ...entries] : entries;
    return [category, group.filter(([id]) =>
      !query || [commandLabel(id), commandDescription(id)].some(text => text.toLowerCase().includes(query)))] as const;
  });

  return (
    <div className="flex max-h-[80vh] flex-col">
      {/* Header */}
      <div className="flex items-center gap-3 border-b border-foreground/10 px-4 py-3">
        <h2 className="shrink-0 text-sm font-semibold">{translate('keyboard.cheatSheetTitle')}</h2>
        <div className="relative flex-1">
          <input
            type="text"
            placeholder={translate('keyboard.cheatSheetSearch')}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full rounded-md border border-foreground/10 bg-[var(--em-surface-input)] px-3 py-1.5 text-sm text-foreground placeholder:text-foreground-muted/60 focus:outline-none focus:border-border-1"
          />
        </div>
        <button
          type="button"
          onClick={() => onClose()}
          className="shrink-0 rounded-sm p-1 text-foreground-muted transition-colors hover:text-foreground"
          aria-label={translate('common.close')}
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path
              d="M1 1L13 13M1 13L13 1"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <div className="mx-auto mb-4 max-w-lg">
          <p className="mb-2 text-tiny text-foreground-muted">{translate('keyboard.hoverHint')}</p>
          <MacKeyboard highlightedKeys={highlightedKeys} />
        </div>
        {editorShortcuts.filter(({ action }) => translate(`keyboard.${action}`).toLowerCase().includes(searchQuery.trim().toLowerCase()))
          .map(({ action, keys }) => <div key={action} className="mb-2 flex justify-between gap-2 px-2">
            <span>{translate(`keyboard.${action}`)}</span>
            <span className="flex gap-2">{keys.map(key => <Shortcut key={key} hotkey={key} variant="keycaps" />)}</span>
          </div>)}
        <div className="grid items-start gap-4 sm:grid-cols-2">
          {groups.map(([category, entries]) => (
            <CategorySection key={category} category={category} categoryLabel={commandCategoryLabel(category)}
              entries={entries} quickChatBinding={quickChatBinding} keyboard={keyboard} activeShortcut={activeShortcut} onActivate={setActiveShortcut} />
          ))}
        </div>
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between border-t border-foreground/10 px-4 py-2">
        <div className="flex items-center gap-3 text-tiny text-foreground-muted">
          <span>
            <kbd className="rounded-sm border border-foreground/10 px-1 font-mono text-micro">↑</kbd>
            <kbd className="ml-0.5 rounded-sm border border-foreground/10 px-1 font-mono text-micro">↓</kbd>
            {` ${translate('keyboard.legendSelect')}`}
          </span>
          <span>
            <kbd className="rounded-sm border border-foreground/10 px-1 font-mono text-micro">Enter</kbd>
            {` ${translate('keyboard.legendPin')}`}
          </span>
          <span>
            <kbd className="rounded-sm border border-foreground/10 px-1 font-mono text-micro">Esc</kbd>
            {` ${translate('keyboard.legendClose')}`}
          </span>
        </div>
        <p className="text-tiny text-foreground-muted">
          {translate('keyboard.customizeHint')}
        </p>
      </div>
    </div>
  );
};
