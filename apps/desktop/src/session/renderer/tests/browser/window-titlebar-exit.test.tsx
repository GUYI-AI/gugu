/**
 * Windows title bar: File → Exit quits the app. The × button closes the window, which hides it to the tray;
 * Exit used to send that same close, so the app never quit from the menu.
 */
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { WindowControls } from '@/components/WindowControls';
import { i18n } from '@/i18n';
import '@renderer/index.css';

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  root?.unmount();
  host?.remove();
  root = null;
  host = null;
  delete document.documentElement.dataset.platform;
  delete document.documentElement.dataset.windowTitlebar;
  Reflect.deleteProperty(window, 'desktopWindow');
});

it('File → Exit quits the app instead of closing the window to the tray', async () => {
  const quit = vi.fn();
  const close = vi.fn();
  document.documentElement.dataset.platform = 'win';
  document.documentElement.dataset.windowTitlebar = 'row';
  Object.assign(window, {
    desktopWindow: {
      minimize: () => undefined,
      maximize: () => undefined,
      close,
      quit,
      isMaximizedSync: () => false,
      onMaximizedChange: () => () => undefined,
    },
  });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  root.render(
    <WindowControls
      activeTab="chats"
      activeChatId={null}
      sessionHostAvailable
      onSelectTab={() => undefined}
      onOpenChat={() => undefined}
      onNewAgent={() => undefined}
      onOpenSettings={() => undefined}
    />
  );
  const t = i18n.getFixedT(null, 'main');
  await page.getByRole('menuitem', { name: t('shell.titlebar.menus.file') }).click();
  await page.getByRole('menuitem', { name: t('shell.titlebar.items.exit') }).click();
  await vi.waitFor(() => expect(quit).toHaveBeenCalledTimes(1));
  expect(close).not.toHaveBeenCalled();
});
