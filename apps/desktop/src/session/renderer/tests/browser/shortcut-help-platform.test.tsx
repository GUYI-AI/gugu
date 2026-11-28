import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { KeyboardShortcutsCheatSheet } from '@renderer/features/settings/components/keyboard-shortcuts-cheat-sheet';
import { commandLabel } from '@renderer/lib/commands/command-copy';
import { CONFIGURABLE_SHORTCUTS } from '@shared/commands';

const host = vi.hoisted(() => ({ desktop: false, supported: false }));
vi.mock('@/components/assistant/useQuickChatState', () => ({
  useQuickChatState: () => ({ available: host.desktop, reading: { state: 'value', value: { supported: host.supported, registered: true } } }),
  quickChatShortcutLabel: () => '⌥⇧Space',
}));
vi.mock('@renderer/features/settings/use-app-settings-key', async () => {
  const { fakeAppSettings } = await import('../../../../../../../tests/support/appSettingsDouble');
  return { useAppSettingsKey: () => fakeAppSettings({ 'app.quickChat': 'Alt+J' }) };
});

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => { await cleanup?.() });

it.each([
  ['web', false, false, 0],
  ['desktop without the native feature', true, false, 0],
  ['desktop with the native feature', true, true, 1],
] as const)('shows the registered Quick Chat shortcut on %s', async (_, desktop, supported, count) => {
  Object.assign(host, { desktop, supported });
  const container = document.body.appendChild(document.createElement('div'));
  const root = createRoot(container);
  cleanup = async () => { await act(async () => root.unmount()); container.remove() };
  await act(async () => root.render(<KeyboardShortcutsCheatSheet onClose={() => {}} onSuccess={() => {}} />));
  const rows = Array.from(container.querySelectorAll('span.truncate')).filter(el => el.textContent === commandLabel('app.quickChat'));
  expect(rows).toHaveLength(count);
  if (count) expect(rows[0].parentElement?.querySelectorAll('kbd')).toHaveLength(1);
  expect(CONFIGURABLE_SHORTCUTS.some(([id]) => id === 'app.quickChat')).toBe(false);
});
