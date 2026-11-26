import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sessionWorkspace } from '@shared/extensions/app-runtime-protocol';

const handlers = new Map<string, (event: unknown, raw: unknown) => Promise<unknown>>();
const external = vi.hoisted(() => vi.fn(async (_url: string) => undefined));
vi.mock('electron', () => ({
  shell: { openExternal: external },
  ipcMain: { handle: (name: string, fn: (event: unknown, raw: unknown) => Promise<unknown>) => handlers.set(name, fn), on: vi.fn() },
  webContents: { fromId: (id: number) => ({ id, isDestroyed: () => false, hostWebContents: { id: 42 }, session: {}, once: vi.fn(), on: vi.fn(), send: vi.fn() }) },
}));
vi.mock('@main/core/extensions/extension-session', () => ({ extensionIdForSession: () => 'workspace', isExtensionSessionConfigured: () => true }));
vi.mock('@main/core/extensions/extension-background', () => ({ extensionBackgroundWebContentsId: () => null }));
vi.mock('@main/core/extensions/extensions-root', () => ({ extensionsService: () => ({
  grantedCapabilities: () => [], hasCapability: () => false, isEnabled: () => true,
  get: () => ({ manifest: { name: 'Files' } }),
}) }));
vi.mock('@main/core/extensions/app-files', () => ({ resourceChatOf: async (id: string) => id }));
vi.mock('@main/lib/logger', () => ({ log: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));
const { bindExtensionSurface, registerExtensionBridge, setExtensionBridgeHost } = await import('./extension-bridge');
const { EXTENSION_BRIDGE_CHANNEL } = await import('@shared/extensions/bridge-protocol');
const { HOST_CALLS } = await import('@shared/extensions/host-calls');
registerExtensionBridge();
const handle = handlers.get(EXTENSION_BRIDGE_CHANNEL)!;
const deliver = vi.fn(async (_origin: unknown, _action: unknown) => undefined);
const call = (sender: number, url: string, options?: { external?: boolean }) =>
  handle({ sender: { id: sender, session: {} } }, { method: 'openBrowserTab', args: HOST_CALLS.openBrowserTab.pack(url, options), gesture: true });

beforeEach(async () => {
  vi.clearAllMocks();
  setExtensionBridgeHost({ deliver, selfGuguNumber: () => undefined,
    presentation: () => ({ locale: 'en', themeMode: 'light', fullscreen: false, windowFocused: true }),
  });
  await bindExtensionSurface({ webContentsId: 7, extensionId: 'workspace', tabId: 'group-app-slot:chat-1#file-1', tabKind: 'workspace.main', conversation: '0b000000-0000-4000-8000-0000000a1514' });
  await bindExtensionSurface({ webContentsId: 8, extensionId: 'workspace', tabId: 'file-2', tabKind: 'workspace.main', workspace: sessionWorkspace('task-1') });
  await bindExtensionSurface({ webContentsId: 9, extensionId: 'workspace', tabId: 'dock', tabKind: 'workspace.main' });
});

describe('Markdown web links through the App host bridge', () => {
  it.each([7, 8])('ordinary clicks from chat/task file pages reach the pane host: %s', async (sender) => {
    expect(await call(sender, 'https://example.com/prices')).toMatchObject({ ok: true });
    expect(deliver).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ pageId: sender }), { kind: 'openBrowserTab', url: 'https://example.com/prices' });
    expect(external).not.toHaveBeenCalled();
  });
  it.each([7, 8])('modified clicks bypass pane creation and reach the system browser: %s', async (sender) => {
    expect(await call(sender, 'https://example.com/prices', { external: true })).toMatchObject({ ok: true });
    expect(external).toHaveBeenCalledExactlyOnceWith('https://example.com/prices');
    expect(deliver).not.toHaveBeenCalled();
  });
  it('a page outside a conversation retains its existing external fallback', async () => {
    expect(await call(9, 'https://example.com/prices')).toMatchObject({ ok: true });
    expect(external).toHaveBeenCalledExactlyOnceWith('https://example.com/prices');
  });
  it.each(['file:///tmp/a.md', 'gugu-ext://workspace/index.html', 'javascript:alert(1)'])('non-web schemes reach neither browser: %s', async (href) => {
    expect(await call(7, href, { external: true })).toMatchObject({ ok: false });
    expect(deliver).not.toHaveBeenCalled();
    expect(external).not.toHaveBeenCalled();
  });
});
