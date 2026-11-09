import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@renderer/lib/ipc', () => ({ rpc: { extensions: {} }, events: { on: () => () => {} } }));
// The 「给哪些 agent」 section reaches the window-bound platform layer; these pages are about the page's own words.
vi.mock('./app-given-section', () => ({ AppGivenSection: () => React.createElement('div', { 'data-testid': 'given' }) }));

const { AppManagePage } = await import('./app-manage-page');

const translate = ((key: string, params?: Record<string, string>) =>
  params ? `${key}(${Object.values(params).join('|')})` : key) as never;

const notes = {
  id: 'notes',
  name: 'Notes',
  version: '1.0.0',
  apiVersion: 35,
  defaultLocale: 'en',
  permissions: { capabilities: ['agents:tools', 'notifications'], network: ['example.com'] },
  settings: [{ key: 'root', type: 'string', title: 'Root folder' }],
  contributes: {
    tabs: [
      { name: 'main', title: 'Notes' },
      { name: 'card', title: 'Note card', widget: { height: 120 } },
      { name: 'file', title: 'Note file', opensFiles: { chat: ['.note'] } },
      { name: 'own', title: 'Accounts' },
    ],
    settingsTab: 'own',
    mcpServers: [{ name: 'notes', command: 'node', args: ['server.mjs'] }],
    skills: 'skills',
    instructions: 'notes__add(text): keep a note.',
  },
} as never;

const api = {
  marketHistory: vi.fn(async () => ({ success: true, data: [] })),
  agentTools: vi.fn(async () => ({ success: true, data: [{ name: 'add', about: 'Add a note' }] })),
  agentSkills: vi.fn(async () => ({ success: true, data: ['notes'] })),
  appData: vi.fn(async () => ({ success: true, data: { bytes: 2048 } })),
};

async function render(props: Record<string, unknown>, then?: (document: Document) => Promise<void>) {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>');
  for (const key of ['window', 'document', 'HTMLElement', 'Element', 'Node', 'navigator', 'getComputedStyle'] as const) {
    vi.stubGlobal(key, key === 'getComputedStyle' ? dom.window.getComputedStyle.bind(dom.window) : dom.window[key]);
  }
  const root = createRoot(dom.window.document.getElementById('root') as HTMLDivElement);
  await act(async () => {
    root.render(React.createElement(AppManagePage, {
      manifest: notes,
      enabled: true,
      lifecycle: { kind: 'open' },
      locale: 'en',
      translate,
      api,
      backLabel: 'back',
      onBack: () => undefined,
      onLifecycle: () => undefined,
      onOpenExternal: () => undefined,
      ...props,
    } as never));
  });
  const document = dom.window.document;
  const text = document.body.textContent ?? '';
  if (then) await then(document);
  act(() => root.unmount());
  vi.unstubAllGlobals();
  return text;
}

const click = (document: Document, selector: string) =>
  act(async () => void document.querySelector(selector)!.dispatchEvent(new document.defaultView!.MouseEvent('click', { bubbles: true })));

describe('App 设置页', () => {
  it('reads what is installed: tools from its program, skills by name, what it keeps here', async () => {
    await render({}, async (document) => {
      expect(document.querySelector('[data-testid="app-manage-tools"]')?.textContent).toContain('extensions.manageTools(1)');
      expect(document.querySelector('[data-testid="app-manage-skills"]')?.textContent).toContain('notes');
    });
    expect(api.agentTools).toHaveBeenCalledWith({ extensionId: 'notes' });
  });

  it('a section it has nothing for is not drawn: an App from a folder has no version history, the phone no agents', async () => {
    await render({ origin: 'folder' }, async (document) => {
      expect(document.querySelector('[data-testid="app-manage-history"]')).toBeNull();
      expect(document.querySelector('[data-testid="app-manage-market"]')).toBeNull();
    });
    const plain = { ...(notes as object), settings: undefined, permissions: undefined, contributes: { tabs: [] } };
    await render({ manifest: plain }, async (document) => {
      expect(document.querySelector('[data-testid="app-manage-version"]')).toBeNull();
      expect(document.querySelector('[data-testid="app-manage-agents"]')).toBeNull();
      expect(document.querySelector('[data-testid="app-manage-pages"]')).toBeNull();
      expect(document.querySelector('[data-testid="app-manage-settings"]')).toBeNull();
    });
  });

  it('turning a page off only exists for pages: not for a card or a file opener', async () => {
    const hide = vi.fn();
    await render({ hiddenTabs: ['own'], onSetTabHidden: hide }, async (document) => {
      expect(document.querySelector('[data-testid="app-manage-page-cards"] [role="switch"]')).toBeNull();
      expect(document.querySelector('[data-testid="app-manage-page-cards"]')?.textContent).toContain('Note card');
      expect(document.querySelector('[data-testid="app-manage-page-files"] [role="switch"]')).toBeNull();
      expect(document.querySelector('[data-testid="app-manage-page-files"]')?.textContent).toContain('.note');
      expect(document.querySelector('[data-testid="app-manage-page-own"] [role="switch"]')?.getAttribute('aria-checked')).toBe('false');
      await click(document, '[data-testid="app-manage-page-main"] [role="switch"]');
    });
    expect(hide).toHaveBeenCalledWith('main', true);
  });

  it('settings the author draws: fields here; its own page is one link away, never embedded', async () => {
    const onOpenTab = vi.fn();
    const read = vi.fn(async () => ({ success: true, data: { root: '~/notes' } }));
    await render({ settingsApi: { read, save: vi.fn() }, onOpenTab }, async (document) => {
      expect(read).toHaveBeenCalled();
      expect(document.querySelector('[data-testid="app-manage-fields"]')?.textContent).toContain('Root folder');
      expect(document.querySelector('webview, iframe')).toBeNull();
      await click(document, '[data-testid="app-manage-own-settings"] button');
    });
    expect(onOpenTab).toHaveBeenCalledWith('own');
  });

  it('权限分项可收回;收回的那项写「恢复」;手机不给回调就只读', async () => {
    const toggle = vi.fn();
    const text = await render({ revoked: ['notifications'], onTogglePermission: toggle }, async (document) => {
      await click(document, '[data-testid="app-permission-notifications"] button');
    });
    expect(toggle).toHaveBeenCalledWith('notifications', true);
    expect(text).toContain('extensions.permissionsWithdrawnNote(3|1)');
    expect(text).toContain('extensions.revoke');
    const phone = await render({});
    expect(phone).not.toContain('extensions.revoke');
    expect(phone).toContain('extensions.permissionsNoteInstall');
  });

  it('data: its size and a clear button; nothing counted says so, and can still be cleared: not all an App keeps is counted', async () => {
    const onClearData = vi.fn();
    await render({ onClearData }, async (document) => {
      expect(document.querySelector('[data-testid="app-manage-data"]')?.textContent).toContain('2 KB');
      await click(document, '[data-testid="app-manage-data-clear"]');
    });
    expect(onClearData).toHaveBeenCalledOnce();
    api.appData.mockResolvedValueOnce({ success: true, data: { bytes: 0 } });
    await render({ onClearData }, async (document) => {
      expect(document.querySelector('[data-testid="app-manage-data"]')?.textContent).toContain('extensions.manageDataNone');
      expect(document.querySelector<HTMLButtonElement>('[data-testid="app-manage-data-clear"]')?.disabled).toBe(false);
    });
  });

  it('says what the market says of this copy, and does not need the market to draw the rest', async () => {
    const install = vi.fn();
    const text = await render({ notice: { kind: 'update', version: '1.1.0', releaseNotes: 'Faster' }, onInstallVersion: install }, async (document) => {
      await click(document, '[data-testid="app-manage-notice"] .xp-link');
    });
    expect(install).toHaveBeenCalledWith({ extensionId: 'notes', version: '1.1.0' });
    expect(text).toContain('extensions.rowHasUpdate(1.1.0)');
    expect(api.marketHistory).not.toHaveBeenCalled();
  });

  it('那台机器离线:动作一起灰,返回照样能走', async () => {
    await render({ readOnly: true, onToggleEnabled: () => undefined, onUninstall: () => undefined, onTogglePermission: () => undefined }, async (document) => {
      expect(document.querySelector('[data-testid="app-manage-switch"]')?.hasAttribute('data-disabled')).toBe(true);
      expect(document.querySelector<HTMLButtonElement>('[data-testid="app-manage-uninstall-action"]')?.disabled).toBe(true);
      expect(document.querySelector<HTMLButtonElement>('[data-testid="app-manage-back"]')?.disabled).toBe(false);
    });
  });
});
