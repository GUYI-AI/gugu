import { act } from 'react';
import { isMacHost } from '@shared/host-os';
import { createRoot, type Root } from 'react-dom/client';
import { userEvent } from '@vitest/browser/context';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dispatchKey, KeyboardDispatcher } from '@renderer/lib/commands/keyboard-dispatcher';
import { commandRegistry } from '@renderer/lib/commands/registry';
import type { CommandProvider } from '@renderer/lib/commands/types';
import { setEmbedVisible } from '@renderer/lib/portal-container';
import { useTabShortcuts } from '@renderer/features/tabs/hooks/useTabShortcuts';
import { dismissOpenModal } from '@renderer/lib/modal/modal-open';

const saved = vi.hoisted(() => ({ keyboard: {} as Record<string, string | null> }));
vi.mock('@renderer/features/settings/use-app-settings-key', async () => { const { fakeAppSettings } = await import('../../../../../../../tests/support/appSettingsDouble'); return { useAppSettingsKey: () => fakeAppSettings(saved.keyboard) } });

// The task page runs inside an open shadow root in the gugu shell; these cases put the focused element there too.
let root: Root;
let container: HTMLDivElement;
let shadow: ShadowRoot;
const disposers: Array<() => void> = [];
const provide = (provider: CommandProvider) => { disposers.push(commandRegistry.register(provider)); };

beforeEach(async () => {
  container = document.createElement('div');
  document.body.append(container);
  const host = document.createElement('div');
  document.body.append(host);
  shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = '<div id="editor" contenteditable="true" style="min-height:20px"></div><div id="pane" tabindex="0">pane</div>';
  root = createRoot(container);
  await act(async () => root.render(<KeyboardDispatcher />));
});

afterEach(async () => {
  saved.keyboard = {};
  disposers.splice(0).forEach((dispose) => dispose());
  setEmbedVisible(true);
  await act(async () => root.unmount());
  document.body.replaceChildren();
});

const modKey = isMacHost() ? 'Meta' : 'Control';
const pressMod = (key: string) => userEvent.keyboard(`{${modKey}>}${key}{/${modKey}}`);
const focus = (id: string) => (shadow.getElementById(id) as HTMLElement).focus();

describe('typing in the task page keeps its keys (shadow root)', () => {
  it('a bare / Alt chord does not fire while typing in a field inside the shadow root, and does on a non-field', async () => {
    const prev = vi.fn();
    provide({ scopeId: 'session', getCommands: () => [{ id: 'session.timelinePrev', execute: prev }] });
    focus('editor');
    await userEvent.keyboard('{Alt>}[[{/Alt}');
    expect(prev).not.toHaveBeenCalled();
    focus('pane');
    await userEvent.keyboard('{Alt>}[[{/Alt}');
    expect(prev).toHaveBeenCalledOnce();
  });

  it('Ctrl+Z in the composer is undo, not zen mode', async () => {
    const zen = vi.fn();
    provide({ scopeId: 'app', getCommands: () => [{ id: 'app.zenMode', execute: zen }] });
    focus('editor');
    await userEvent.keyboard('{Control>}z{/Control}');
    expect(zen).not.toHaveBeenCalled();
  });
});

describe('a command with nothing to do lets the key through', () => {
  it.each([
    ['disabled', { enabled: false, execute: vi.fn() }],
    ['declined', { execute: () => false as const }],
  ])('%s: the layer underneath still receives Mod+[', async (_, command) => {
    provide({ scopeId: 'app', getCommands: () => [{ id: 'app.navigateBack', ...command }] });
    const below = vi.fn((event: KeyboardEvent) => event.defaultPrevented);
    const onKey = (event: KeyboardEvent) => { if (event.key === '[') below(event); };
    window.addEventListener('keydown', onKey);
    focus('pane');
    await pressMod('[[');
    window.removeEventListener('keydown', onKey);
    expect(below).toHaveBeenCalledOnce();
    expect(below.mock.results[0]!.value).toBe(false);
  });

  it('a command that acts takes the key', async () => {
    const back = vi.fn();
    provide({ scopeId: 'app', getCommands: () => [{ id: 'app.navigateBack', execute: back }] });
    const below = vi.fn();
    const onKey = (event: KeyboardEvent) => { if (event.key === '[') below(); };
    window.addEventListener('keydown', onKey);
    focus('pane');
    await pressMod('[[');
    window.removeEventListener('keydown', onKey);
    expect(back).toHaveBeenCalledOnce();
    expect(below).not.toHaveBeenCalled();
  });
});

describe('while the task page is hidden behind another shell tab', () => {
  it('shell commands and shell surfaces still answer; task-page-only commands stand down', async () => {
    const settings = vi.fn();
    const closeTab = vi.fn();
    const contactsFind = vi.fn();
    provide({ scopeId: 'app', getCommands: () => [{ id: 'app.settings', execute: settings }] });
    provide({ scopeId: 'session-sub', getCommands: () => [{ id: 'session.tabClose', execute: closeTab }] });
    provide({ scopeId: 'session-sub', surface: 'shell', getCommands: () => [{ id: 'app.find', execute: contactsFind }] });
    await act(async () => setEmbedVisible(false));
    focus('pane');
    await pressMod(',');
    await pressMod('w');
    await pressMod('f');
    expect(settings).toHaveBeenCalledOnce();
    expect(closeTab).not.toHaveBeenCalled();
    expect(contactsFind).toHaveBeenCalledOnce();
  });
});

describe('the registry', () => {
  it('pauses nest: shortcuts resume only when the last holder lets go', async () => {
    const settings = vi.fn();
    provide({ scopeId: 'app', getCommands: () => [{ id: 'app.settings', execute: settings }] });
    const first = commandRegistry.pauseShortcuts();
    const second = commandRegistry.pauseShortcuts();
    first();
    first();
    focus('pane');
    await pressMod(',');
    expect(settings).not.toHaveBeenCalled();
    second();
    await pressMod(',');
    expect(settings).toHaveBeenCalledOnce();
  });

  it('keeps a non-tab command in the shell on non-Mac terminals', async () => {
    saved.keyboard = { 'app.library': 'Control+Y' };
    await act(async () => root.render(<KeyboardDispatcher key="shell" />));
    const openMarket = vi.fn();
    provide({ scopeId: 'app', getCommands: () => [{ id: 'app.library', execute: openMarket }] });
    const terminal = shadow.getElementById('editor')!;
    const consume = vi.fn((event: KeyboardEvent) => {
      const claimed = dispatchKey(event, 'terminal');
      event.stopPropagation();
      return claimed;
    });
    terminal.addEventListener('keydown', consume);
    focus('editor');
    await userEvent.keyboard('{Control>}y{/Control}');
    expect(openMarket).toHaveBeenCalledTimes(isMacHost() ? 1 : 0);
    expect(consume.mock.results.some(result => result.value)).toBe(isMacHost());
    terminal.removeEventListener('keydown', consume);
    focus('pane');
    await userEvent.keyboard('{Control>}y{/Control}');
    expect(openMarket).toHaveBeenCalledTimes(isMacHost() ? 2 : 1);
  });

  it('dispatches navigation arrows and character help from the hidden navigation holder', async () => {
    const holder = shadow.appendChild(document.createElement('div'));
    holder.dataset.region = 'session-nav-focus';
    holder.tabIndex = -1;
    holder.setAttribute('aria-hidden', 'true');
    const next = vi.fn();
    const help = vi.fn();
    provide({ scopeId: 'session', getCommands: () => [
      { id: 'session.next', execute: next }, { id: 'app.showKeyboardShortcuts', execute: help },
    ] });
    holder.focus();
    await userEvent.keyboard('{ArrowDown}');
    expect(shadow.activeElement).toBe(holder);
    await pressMod('{ArrowDown}');
    expect(next).toHaveBeenCalledOnce();
    await userEvent.keyboard('?');
    expect(help).toHaveBeenCalledOnce();
  });

  it('lets a rebound tab command leave the terminal and keeps its disabled alias inside', async () => {
    saved.keyboard = { 'session.tabPrev': 'Control+Y', 'session.tabNext': null };
    await act(async () => root.render(<KeyboardDispatcher key="rebound" />));
    const previous = vi.fn();
    const next = vi.fn();
    provide({ scopeId: 'session-sub', getCommands: () => [
      { id: 'session.tabPrev', execute: previous }, { id: 'session.tabNext', execute: next },
    ] });
    const terminal = shadow.getElementById('editor')!;
    terminal.addEventListener('keydown', event => {
      dispatchKey(event, 'terminal');
      event.stopPropagation();
    });
    focus('editor');
    await userEvent.keyboard('{Control>}y{/Control}');
    expect(previous).toHaveBeenCalledOnce();
    await userEvent.keyboard('{Control>}{Tab}{/Control}');
    expect(next).not.toHaveBeenCalled();
  });

  it('Ctrl+Tab is an alias of next tab', async () => {
    const next = vi.fn();
    provide({ scopeId: 'session-sub', getCommands: () => [{ id: 'session.tabNext', execute: next }] });
    focus('editor');
    await userEvent.keyboard('{Control>}{Tab}{/Control}');
    expect(next).toHaveBeenCalledOnce();
  });
});

describe('⌘W over a modal', () => {
  function Pane({ close }: { close: () => void }) {
    useTabShortcuts({ setNextTabActive: vi.fn(), setPreviousTabActive: vi.fn(), setTabActiveIndex: vi.fn(), closeActiveTab: close });
    return null;
  }

  it('the pane keeps its tab while a modal is up; without one it closes it', async () => {
    const close = vi.fn();
    const paneRoot = createRoot(document.body.appendChild(document.createElement('div')));
    await act(async () => paneRoot.render(<Pane close={close} />));
    const sheet = document.body.appendChild(Object.assign(document.createElement('div'), { tabIndex: -1 }));
    sheet.setAttribute('aria-modal', 'true');
    expect(commandRegistry.dispatch('session.tabClose')).toBe(false);
    expect(close).not.toHaveBeenCalled();
    sheet.remove();
    expect(commandRegistry.dispatch('session.tabClose')).toBe(true);
    expect(close).toHaveBeenCalledOnce();
    // a pane with no tab left has nothing to do with ⌘W: the key goes on to the next answer (the window)
    close.mockReturnValue(false);
    expect(commandRegistry.dispatch('session.tabClose')).toBe(false);
    await act(async () => paneRoot.unmount());
  });

  it('dismissing the modal is its own Escape, delivered where the focus is', async () => {
    const sheet = document.body.appendChild(document.createElement('div'));
    sheet.setAttribute('aria-modal', 'true');
    const field = sheet.appendChild(document.createElement('input'));
    const escape = vi.fn((event: KeyboardEvent) => event.key);
    sheet.addEventListener('keydown', escape);
    field.focus();
    dismissOpenModal();
    expect(escape).toHaveBeenCalledOnce();
    expect(escape.mock.results[0]!.value).toBe('Escape');
  });
});

describe('the mark-all-read shortcut belongs to the workspace', () => {
  it('leaves fields and overlays alone and takes the key again on the conversation pane', async () => {
    const mark = vi.fn();
    provide({ scopeId: 'app', getCommands: () => [{ id: 'chat.markAllRead', execute: mark }] });
    const press = () => userEvent.keyboard('{Shift>}{Escape}{/Shift}');
    focus('editor');
    await press();
    expect(mark).not.toHaveBeenCalled();
    for (const attribute of ['role', 'cmdk-root']) {
      const overlay = document.createElement('div');
      overlay.setAttribute(attribute, attribute === 'role' ? 'dialog' : '');
      const button = overlay.appendChild(document.createElement('button'));
      shadow.append(overlay);
      button.focus();
      await press();
      expect(mark).not.toHaveBeenCalled();
      overlay.remove();
    }
    const sheet = document.body.appendChild(document.createElement('div'));
    sheet.setAttribute('aria-modal', 'true');
    focus('pane');
    await press();
    expect(mark).not.toHaveBeenCalled();
    sheet.remove();
    await press();
    expect(mark).toHaveBeenCalledOnce();
  });
});
