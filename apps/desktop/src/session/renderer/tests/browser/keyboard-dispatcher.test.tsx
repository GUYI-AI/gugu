import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { userEvent } from '@vitest/browser/context';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KeyboardDispatcher } from '@renderer/lib/commands/keyboard-dispatcher';
import { commandRegistry } from '@renderer/lib/commands/registry';
import type { CommandProvider } from '@renderer/lib/commands/types';
import { setEmbedVisible } from '@renderer/lib/portal-container';

vi.mock('@renderer/features/settings/use-app-settings-key', async () => { const { fakeAppSettings } = await import('../../../../../../../tests/support/appSettingsDouble'); return { useAppSettingsKey: () => fakeAppSettings({}) } });

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
  disposers.splice(0).forEach((dispose) => dispose());
  setEmbedVisible(true);
  await act(async () => root.unmount());
  document.body.replaceChildren();
});

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
    await userEvent.keyboard('{Control>}[[{/Control}');
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
    await userEvent.keyboard('{Control>}[[{/Control}');
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
    await userEvent.keyboard('{Control>},{/Control}');
    await userEvent.keyboard('{Control>}w{/Control}');
    await userEvent.keyboard('{Control>}f{/Control}');
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
    await userEvent.keyboard('{Control>},{/Control}');
    expect(settings).not.toHaveBeenCalled();
    second();
    await userEvent.keyboard('{Control>},{/Control}');
    expect(settings).toHaveBeenCalledOnce();
  });

  it('Ctrl+Tab is a fixed alias of next tab', async () => {
    const next = vi.fn();
    provide({ scopeId: 'session-sub', getCommands: () => [{ id: 'session.tabNext', execute: next }] });
    focus('editor');
    await userEvent.keyboard('{Control>}{Tab}{/Control}');
    expect(next).toHaveBeenCalledOnce();
  });
});
