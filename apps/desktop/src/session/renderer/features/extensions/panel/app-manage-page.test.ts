import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Each render is another host (`remote:<n>`): the page reads its tools, skills, data and settings through that host's API.
const apis = vi.hoisted(() => new Map<string, unknown>());
vi.mock('@renderer/lib/ipc', () => ({ rpc: { extensions: {} }, rpcOn: (id: string) => ({ extensions: apis.get(id) }), events: { on: () => () => {} }, onMachineEvent: () => () => {} }));
let hosts = 0;
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
  const device = `manage-${++hosts}`;
  const given = (props.api ?? api) as Record<string, unknown>;
  const settings = (props.settingsApi as { read?: unknown } | undefined)?.read;
  apis.set(device, settings ? { ...given, settings } : given);
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
      hostKey: `remote:${device}`,
      ...props,
    } as never));
  });
  // Its reads are replicas: their answers land after a task boundary (react-query's notify), ❌ a clock.
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
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

  it('read before, a refresh that fails is said with a retry, what was read staying: tools, skills, data size', async () => {
    let fail = false;
    const failing = <T,>(data: T) => vi.fn(async () => (fail ? { success: false, error: 'machine unreachable' } : { success: true, data }));
    const given = { ...api, agentTools: failing([{ name: 'add', about: 'Add a note' }]), agentSkills: failing(['notes']), appData: failing({ bytes: 2048 }) };
    const { extensionAgentTools, extensionAgentSkills, extensionDataBytes } = await import('../market-replicas');
    apis.set('manage-refresh', given);
    await render({ api: given, hostKey: 'remote:manage-refresh', onClearData: () => undefined }, async (document) => {
      expect(document.querySelectorAll('[data-refresh-failed]')).toHaveLength(0);
      fail = true;
      await act(async () => {
        await Promise.all([
          extensionAgentTools.refresh('remote:manage-refresh', 'notes', '1.0.0'),
          extensionAgentSkills.refresh('remote:manage-refresh', 'notes', '1.0.0'),
          extensionDataBytes.refresh('remote:manage-refresh', 'notes'),
        ]).catch(() => undefined);
      });
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
      expect(document.querySelectorAll('[data-refresh-failed]')).toHaveLength(3);
      expect(document.querySelector('[data-testid="app-manage-tools"]')?.textContent).toContain('extensions.manageTools(1)');
      expect(document.querySelector('[data-testid="app-manage-skills"]')?.textContent).toContain('notes');
    });
  });

  it('the tools heading waits for the tools: never 「给 agent 的工具」 first and then 「工具（N）」', async () => {
    let answer!: (reply: unknown) => void;
    const agentTools = vi.fn(() => new Promise((resolve) => { answer = resolve; }));
    await render({ api: { ...api, agentTools } }, async (document) => {
      const row = () => document.querySelector('[data-testid="app-manage-tools"]');
      expect(row()?.textContent).not.toContain('extensions.addsTools');
      expect(row()?.textContent).not.toContain('extensions.inspecting');
      expect(row()?.querySelector('[data-unknown]')).not.toBeNull();
      await act(async () => { answer({ success: true, data: [{ name: 'add', about: 'Add a note' }, { name: 'list', about: null }] }); });
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
      expect(row()?.textContent).toContain('extensions.manageTools(2)');
      expect(row()?.querySelector('[data-unknown]')).toBeNull();
    });
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
