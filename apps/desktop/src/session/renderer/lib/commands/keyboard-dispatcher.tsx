import { detectPlatform, matchesKeyboardEvent, parseHotkey, type Hotkey } from '@tanstack/react-hotkeys';
import { observer } from 'mobx-react-lite';
import { useEffect } from 'react';
import { revealSessionpage } from '@/hooks/useSessionpageReveal';
import { COMMANDS, getEffectiveHotkey, isHostCommandId, type CommandId, useShortcutOverrides } from '@renderer/lib/hooks/useKeyboardShortcuts';
import { isEmbedVisible, subscribeEmbedVisibility } from '@renderer/lib/portal-container';
import { commandRegistry } from './registry';

type Overrides = ReturnType<typeof useShortcutOverrides>;
/** Where the key came from. 'aux' = a popped-out window's document; 'terminal' = handed over by xterm's own key handler. */
export type KeySource = 'capture' | 'bubble' | 'aux' | 'terminal';

const PLATFORM = detectPlatform();
const TEXT_FIELD = 'input, textarea, select, [contenteditable="true"], [contenteditable=""]';
let overrides: Overrides = null;

/** The element the key really started on. The task page is in an open shadow root, so `event.target` is its host here. */
function origin(event: KeyboardEvent): HTMLElement | null {
  return event.composedPath().find((node): node is HTMLElement => node instanceof HTMLElement) ?? null;
}

function inTextField(element: HTMLElement | null): boolean {
  if (!element) return false;
  if (element instanceof HTMLInputElement) return !['button', 'submit', 'reset', 'checkbox', 'radio'].includes(element.type);
  return element.closest(TEXT_FIELD) !== null;
}

/** A bare key or a Shift/Alt chord belongs to a text field the user is typing in; ⌘/Ctrl chords and Escape do not. */
function yieldsToText(id: CommandId, hotkey: Hotkey): boolean {
  const own = COMMANDS[id].ignoreInputs;
  if (own !== undefined) return own;
  const parsed = parseHotkey(hotkey, PLATFORM);
  return !(parsed.ctrl || parsed.meta || parsed.key === 'Escape');
}

function runWhenVisible(id: CommandId): void {
  if (isEmbedVisible()) { commandRegistry.dispatch(id); return; }
  // The task page has to be on screen before its modal can take focus.
  const stop = subscribeEmbedVisibility(() => {
    if (!isEmbedVisible()) return;
    stop();
    requestAnimationFrame(() => commandRegistry.dispatch(id));
  });
  revealSessionpage();
}

/**
 * The one place a keydown becomes a command. Returns whether a command took the key; a command that has nothing to do
 * right now (`enabled: false`, or `execute` returning false) does not take it, so whatever is underneath still gets it.
 */
export function dispatchKey(event: KeyboardEvent, source: KeySource): boolean {
  // Mid-composition the key belongs to the input method (Safari reports the commit Enter as keyCode 229).
  if (commandRegistry.shortcutsPaused || event.isComposing || event.keyCode === 229 || overrides === null) return false;
  const start = origin(event);
  const inEditor = !!start?.closest('.cm-editor');
  const typing = source !== 'terminal' && inTextField(start);
  const seen = new Set<string>();
  for (const command of commandRegistry.activeCommands) {
    const id = command.id;
    if (seen.has(id) || !isHostCommandId(id)) continue;
    seen.add(id);
    const def = COMMANDS[id];
    if (def.conflictBehavior === 'allow') continue;
    // Capture phase: the entry keys a terminal or modal root would swallow, and everything while a code editor holds
    // focus (CodeMirror stops the keys its keymaps bind) except what the editor keeps for itself.
    if (source === 'capture' && !def.capture && !(inEditor && !def.ignoreWhenCodeEditorFocused)) continue;
    if (source === 'bubble' && (def.capture || (inEditor && !def.ignoreWhenCodeEditorFocused))) continue;
    const hotkeys = [getEffectiveHotkey(id, overrides), ...(def.aliases ?? [])].filter((h): h is Hotkey => !!h);
    const hotkey = hotkeys.find((h) => matchesKeyboardEvent(event, h, PLATFORM));
    if (!hotkey) continue;
    if (typing && !def.capture && !inEditor && yieldsToText(id, hotkey)) continue;
    // @@@native-editor-find — CodeMirror owns replacement, regex and selection search; only app.find yields.
    if (id === 'app.find' && start?.closest('.cm-editor, [cmdk-root], [role=menu]')) continue;
    if (!commandRegistry.sessionPageVisible && def.whenSessionPageHidden === 'reveal') {
      runWhenVisible(id);
    } else if (!commandRegistry.dispatch(id)) {
      continue;
    }
    event.preventDefault();
    if (source === 'capture') event.stopImmediatePropagation();
    else event.stopPropagation();
    return true;
  }
  return false;
}

/**
 * A keymap that is a table of its own rather than one command per chord (the session-page keyboard navigation: which
 * layer a key belongs to decides what it does). Layers see every key that reaches the document after the commands, in
 * the same listener, so the two never race; a layer does its own preventDefault when it acts.
 */
export type KeyLayer = (event: KeyboardEvent) => void;
const layers = new Set<KeyLayer>();
export function registerKeyLayer(layer: KeyLayer): () => void {
  layers.add(layer);
  return () => { layers.delete(layer); };
}

function install(): () => void {
  const sync = () => commandRegistry.setSessionPageVisible(isEmbedVisible());
  sync();
  const stopVisibility = subscribeEmbedVisibility(sync);
  const context = (event: Event) => {
    const element = event.composedPath().find((node): node is HTMLElement => node instanceof HTMLElement);
    if (element) commandRegistry.setContext(element);
  };
  const capture = (event: KeyboardEvent) => { dispatchKey(event, 'capture'); };
  const bubble = (event: KeyboardEvent) => {
    dispatchKey(event, 'bubble');
    for (const layer of layers) layer(event);
  };
  document.addEventListener('focusin', context, true);
  document.addEventListener('pointerdown', context, true);
  document.addEventListener('keydown', capture, true);
  document.addEventListener('keydown', bubble);
  return () => {
    stopVisibility();
    document.removeEventListener('focusin', context, true);
    document.removeEventListener('pointerdown', context, true);
    document.removeEventListener('keydown', capture, true);
    document.removeEventListener('keydown', bubble);
  };
}

let mounts = 0;
let uninstall: (() => void) | null = null;

/**
 * Listens for the whole document, always — not only while the task page is on screen: the shell's own tabs need their
 * shortcuts too (⌘P, ⌘, … used to go dead on 通讯录). Which commands answer while the task page is hidden is the
 * registry's call. Mounted by the shell and by the task page (which also runs standalone); the listeners go in once.
 */
export const KeyboardDispatcher = observer(function KeyboardDispatcher() {
  overrides = useShortcutOverrides();
  useEffect(() => {
    if (mounts++ === 0) uninstall = install();
    return () => {
      if (--mounts === 0) { uninstall?.(); uninstall = null; }
    };
  }, []);
  return null;
});
