import { sessionWorkspace } from '@shared/extensions/app-runtime-protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `@@@outside-grant`, where the host makes it: a page bound to a file outside its working copy that a person opened gets
 * a grant of its own, read right away so the file's machine binds it to the file it is now. A file the host opened for an
 * agent or an App (`byHost`: `open_in_tab`, `files.openWith`), a page an agent works, or a file of the working copy gets
 * none; another file, or the page bound again, gets a new one, and an unbound page has none.
 */
const PAGE = 7;
const OUTSIDE = '/elsewhere/notes.md';
const readAppFile = vi.hoisted(() => vi.fn(async () => ({ size: 0, etag: 'e', offset: 0, data: new Uint8Array() })));

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  webContents: {
    fromId: (id: number) => id === PAGE
      ? { id, isDestroyed: () => false, hostWebContents: { id: 42 }, isFocused: () => false, session: {}, once: () => undefined, on: () => undefined, send: () => undefined }
      : undefined,
  },
}));
vi.mock('@main/core/extensions/extension-session', () => ({ extensionIdForSession: () => 'workspace', isExtensionSessionConfigured: () => true }));
vi.mock('@main/core/extensions/extension-background', () => ({ extensionBackgroundWebContentsId: () => null }));
vi.mock('@main/core/extensions/extensions-root', () => ({
  extensionsService: () => ({ grantedCapabilities: () => ['files:read'], hasCapability: () => true,
    isEnabled: () => true, get: () => ({ manifest: { name: 'Workspace', version: '1.0.0' } }) }),
}));
vi.mock('@main/core/extensions/app-programs-elsewhere', () => ({ knownSessionMachine: () => null, sessionMachine: async () => null }));
vi.mock('@main/lib/logger', () => ({ log: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('@main/core/extensions/app-files', () => ({
  readAppFile,
  resourceChatOf: async (chatId: string) => chatId,
  localRootOf: async () => ({ workspaceRoot: '/repo' }),
  chatMembersOf: async () => [],
  surfaceChatOf: async () => null,
}));

const { bindExtensionSurface, retargetExtensionSurface, unbindExtensionSurface, extensionSurfaceBindingForTests, setExtensionBridgeHost } = await import('./extension-bridge');
const workspace = sessionWorkspace('task-a');
const bind = (extra: Record<string, unknown>) =>
  bindExtensionSurface({ webContentsId: PAGE, extensionId: 'workspace', tabId: 'slot-1', tabKind: 'workspace.file', workspace, filePath: OUTSIDE, ...extra });
const grant = () => extensionSurfaceBindingForTests(PAGE)?.grant;

beforeEach(() => {
  unbindExtensionSurface(PAGE);
  readAppFile.mockClear();
  setExtensionBridgeHost({ deliver: () => Promise.resolve(), presentation: () => ({ locale: 'en', themeMode: 'dark' as const, fullscreen: false, windowFocused: true }) });
});

describe('the grant for a file outside the working copy', () => {
  it('a person opening it makes one, read right away for that file and never told the page', async () => {
    await bind({});
    expect(grant()).toEqual(expect.any(String));
    await vi.waitFor(() => expect(readAppFile).toHaveBeenCalledWith(
      expect.objectContaining({ handed: { workspace, id: OUTSIDE }, grant: grant() }), { ref: { workspace, id: OUTSIDE }, offset: 0, length: 0 }));
  });

  it('none for a file opened for an agent or an App, for a page an agent works, or for a file of the working copy', async () => {
    await bind({ byHost: true });
    expect(grant()).toBeUndefined();
    unbindExtensionSurface(PAGE);
    await bind({ operator: { kind: 'agent', id: 'user:0a000000-0000-4000-8000-000000000001' } });
    expect(grant()).toBeUndefined();
    unbindExtensionSurface(PAGE);
    await bind({ filePath: 'src/a.ts' });
    expect(grant()).toBeUndefined();
    expect(readAppFile).not.toHaveBeenCalled();
  });

  it('another file, or the same one opened by the host instead, changes it; the page unbound has none', async () => {
    await bind({});
    const first = grant();
    await retargetExtensionSurface({ webContentsId: PAGE, tabId: 'slot-1', workspace, filePath: OUTSIDE });
    expect(grant()).toBe(first);
    await retargetExtensionSurface({ webContentsId: PAGE, tabId: 'slot-1', workspace, filePath: '/elsewhere/other.md' });
    expect(grant()).toEqual(expect.any(String));
    expect(grant()).not.toBe(first);
    await retargetExtensionSurface({ webContentsId: PAGE, tabId: 'slot-1', workspace, filePath: '/elsewhere/other.md', byHost: true });
    expect(grant()).toBeUndefined();
    unbindExtensionSurface(PAGE);
    expect(extensionSurfaceBindingForTests(PAGE)).toBeUndefined();
  });
});
