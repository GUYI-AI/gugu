import { act } from 'react';
import { userEvent } from '@vitest/browser/context';
import KeyboardSettingsCard from '@renderer/features/settings/components/KeyboardSettingsCard';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { KeyboardShortcutsCheatSheet } from '@renderer/features/settings/components/keyboard-shortcuts-cheat-sheet';
import { commandLabel } from '@renderer/lib/commands/command-copy';
import { QUICK_CHAT_CHANNELS } from '@/lib/quickChatIpc';
import { CONFIGURABLE_SHORTCUTS } from '@shared/commands';

const host = vi.hoisted(() => ({ desktop: false, supported: false, registered: true, accelerator: 'Alt+Shift+Space', update: vi.fn(), toast: vi.fn() }));
const ipc = vi.hoisted(() => ({
  invoke: vi.fn().mockResolvedValue(undefined),
  listeners: new Map<string, (value: unknown) => void>(),
}));
vi.mock('@/platform/desktopIpc', () => ({
  desktopIpc: () => host.desktop ? {
    invoke: ipc.invoke,
    eventOn: (channel: string, listener: (value: unknown) => void) => {
      ipc.listeners.set(channel, listener);
      return () => ipc.listeners.delete(channel);
    },
  } : null,
}));
vi.mock('@renderer/lib/hooks/use-toast', () => ({ toast: host.toast }));
vi.mock('@renderer/features/settings/use-terminal-enabled', async importOriginal => ({
  ...await importOriginal<typeof import('@renderer/features/settings/use-terminal-enabled')>(),
  useTerminalEnabled: () => ({ state: 'value', value: false }),
}));
vi.mock('@/components/assistant/useQuickChatState', () => ({
  useQuickChatState: () => ({ available: host.desktop, reading: { state: 'value', value: { supported: host.supported, registered: host.registered, accelerator: host.accelerator } } }),
  quickChatShortcutLabel: () => '⌥⇧Space',
}));
vi.mock('@renderer/features/settings/use-app-settings-key', async () => {
  const { fakeAppSettings } = await import('../../../../../../../tests/support/appSettingsDouble');
  return { useAppSettingsKey: () => fakeAppSettings({ 'app.quickChat': 'Alt+J' }, { update: host.update }) };
});

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  host.update.mockClear();
  host.toast.mockClear();
  ipc.invoke.mockClear();
});

it.each([
  ['web', false, false, false, false],
  ['unsupported desktop', true, false, false, false],
  ['unregistered desktop shortcut', true, true, false, false],
  ['stale registration without a native receipt', true, true, true, false],
  ['native receipt for a custom shortcut', true, true, true, true],
] as const)('resolves a recorded chord against the actual registration on %s', async (_, desktop, supported, registered, received) => {
  Object.assign(host, { desktop, supported, registered, accelerator: 'Control+Shift+F11' });
  const container = document.body.appendChild(document.createElement('div'));
  const root = createRoot(container);
  cleanup = async () => { await act(async () => root.unmount()); container.remove() };
  await act(async () => root.render(<KeyboardSettingsCard />));
  const record = container.querySelector<HTMLButtonElement>('[data-command-id="app.library"] button.justify-end')!;
  await userEvent.click(record);
  if (received) {
    expect(ipc.invoke).toHaveBeenCalledWith(QUICK_CHAT_CHANNELS.recordShortcut, true);
    await act(async () => ipc.listeners.get(QUICK_CHAT_CHANNELS.shortcutRecorded)!(host.accelerator));
    expect(ipc.invoke).toHaveBeenCalledWith(QUICK_CHAT_CHANNELS.recordShortcut, false);
    expect(ipc.listeners.has(QUICK_CHAT_CHANNELS.shortcutRecorded)).toBe(false);
    expect(host.update).not.toHaveBeenCalled();
    expect(host.toast).toHaveBeenCalledWith(expect.objectContaining({ description: expect.stringContaining(commandLabel('app.quickChat')) }));
  } else {
    await userEvent.keyboard('{Control>}{Shift>}{F11}{/Shift}{/Control}');
    expect(host.update).toHaveBeenCalledWith({ 'app.library': expect.stringContaining('F11') });
  }
});

it.each([
  ['web', false, false, 0],
  ['desktop without the native feature', true, false, 0],
  ['desktop with the native feature', true, true, 1],
] as const)('shows the registered Quick Chat shortcut on %s', async (_, desktop, supported, count) => {
  Object.assign(host, { desktop, supported, registered: true, accelerator: 'Alt+Shift+Space' });
  const container = document.body.appendChild(document.createElement('div'));
  const root = createRoot(container);
  cleanup = async () => { await act(async () => root.unmount()); container.remove() };
  await act(async () => root.render(<KeyboardShortcutsCheatSheet onClose={() => {}} onSuccess={() => {}} />));
  const rows = Array.from(container.querySelectorAll('span.truncate')).filter(el => el.textContent === commandLabel('app.quickChat'));
  expect(rows).toHaveLength(count);
  if (count) expect(rows[0].parentElement?.querySelectorAll('kbd')).toHaveLength(1);
  expect(CONFIGURABLE_SHORTCUTS.some(([id]) => id === 'app.quickChat')).toBe(false);
});
