import { sessionWorkspace } from '@shared/extensions/app-runtime-protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `@@@outside-file`, where the host marks it: a page bound to a file named absolute that a person opened is `personOpened`,
 * which its calls stamp for the file's machine. A file the host opened for an agent or an App (`byHost`: `open_in_tab`,
 * `files.openWith`), a page an agent works, or a file of the working copy is not; the page bound again is marked afresh.
 */
const PAGE = 7;
const OUTSIDE = '/elsewhere/notes.md';

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
  resourceChatOf: async (chatId: string) => chatId,
  localRootOf: async () => ({ workspaceRoot: '/repo' }),
  chatMembersOf: async () => [],
  surfaceChatOf: async () => null,
}));

const { bindExtensionSurface, retargetExtensionSurface, unbindExtensionSurface, extensionSurfaceBindingForTests, setExtensionBridgeHost } = await import('./extension-bridge');
const workspace = sessionWorkspace('task-a');
const bind = (extra: Record<string, unknown>) =>
  bindExtensionSurface({ webContentsId: PAGE, extensionId: 'workspace', tabId: 'slot-1', tabKind: 'workspace.file', workspace, filePath: OUTSIDE, ...extra });
const opened = () => extensionSurfaceBindingForTests(PAGE)?.personOpened;

beforeEach(() => {
  unbindExtensionSurface(PAGE);
  setExtensionBridgeHost({ deliver: () => Promise.resolve(), selfGuguNumber: () => undefined, presentation: () => ({ locale: 'en', themeMode: 'dark' as const, fullscreen: false, windowFocused: true }) });
});

describe('a file outside the working copy, as a person opened it', () => {
  it('a person opening it marks the page, and nothing is read for it as it opens', async () => {
    await bind({});
    expect(opened()).toBe(true);
  });

  it('not for a file opened for an agent or an App, for a page an agent works, or for a file of the working copy', async () => {
    await bind({ byHost: true });
    expect(opened()).toBeUndefined();
    unbindExtensionSurface(PAGE);
    await bind({ operator: { kind: 'agent', id: 'user:0a000000-0000-4000-8000-000000000001' } });
    expect(opened()).toBeUndefined();
    unbindExtensionSurface(PAGE);
    await bind({ filePath: 'src/a.ts' });
    expect(opened()).toBeUndefined();
  });

  it('bound again, the page is marked by that opening: the host opening the same file unmarks it; unbound, it is gone', async () => {
    await bind({});
    await retargetExtensionSurface({ webContentsId: PAGE, tabId: 'slot-1', workspace, filePath: '/elsewhere/other.md' });
    expect(opened()).toBe(true);
    await retargetExtensionSurface({ webContentsId: PAGE, tabId: 'slot-1', workspace, filePath: '/elsewhere/other.md', byHost: true });
    expect(opened()).toBeUndefined();
    unbindExtensionSurface(PAGE);
    expect(extensionSurfaceBindingForTests(PAGE)).toBeUndefined();
  });
});
