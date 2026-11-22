import { beforeEach, expect, it, vi } from 'vitest';

// A reader taken out of a chat is cut off at once (read-contract §2.5): its page there is revoked — what it read goes
// with the page — and its running calls handed that chat lose it. Another member leaving takes nothing of this reader's.

const PAGE = 7;
const CHAT = '0b000000-0000-4000-8000-000000000001';
const ME = '0a000000-0000-4000-8000-00000000000a';
const OTHER = '0a000000-0000-4000-8000-00000000000b';
const hooks = vi.hoisted(() => ({ revoke: vi.fn(async () => undefined), endCallsIn: vi.fn() }));

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  webContents: {
    fromId: (id: number) =>
      id === 7 ? { id, isDestroyed: () => false, hostWebContents: { id: 42 }, session: {}, once: () => undefined, on: () => undefined, send: () => undefined } : undefined,
  },
}));
vi.mock('@main/core/extensions/extension-session', () => ({ extensionIdForSession: () => 'workspace', isExtensionSessionConfigured: () => true }));
vi.mock('@main/core/extensions/extension-background', () => ({ extensionBackgroundWebContentsId: () => null }));
vi.mock('@main/core/extensions/extensions-root', () => ({
  extensionsService: () => ({ grantedCapabilities: () => ['files:read'], hasCapability: () => true, get: () => ({ manifest: { name: 'Workspace' } }) }),
}));
vi.mock('@main/lib/logger', () => ({ log: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('@main/core/extensions/app-files', () => ({
  resourceChatOf: async (chatId: string) => chatId,
  chatMembersOf: async () => [{ id: `user:${ME}`, name: 'a', kind: 'human' }],
  surfaceChatOf: async () => ({ id: '0b000000-0000-4000-8000-000000000001', name: 'G', kind: 'group', groupId: '0b000000-0000-4000-8000-000000000001' }),
}));
vi.mock('@main/core/extensions/account-token', () => ({ currentAccountAccessToken: async () => 'token' }));
vi.mock('@gugu/core', async (load) => ({ ...(await load<object>()), userIdFromSupabaseAccessToken: () => '0a000000-0000-4000-8000-00000000000a' }));
vi.mock('@main/core/extensions/extension-program-surface', async (load) => ({ ...(await load<object>()), endCallsIn: hooks.endCallsIn }));
vi.mock('@main/core/extensions/file-sync', async (load) => {
  const real = await load<{ fileSync: object }>();
  return { ...real, fileSync: new Proxy(real.fileSync, { get: (target, key) => (key === 'revoke' ? hooks.revoke : Reflect.get(target, key)) }) };
});

const { bindExtensionSurface, chatMembersChanged, setExtensionBridgeHost } = await import('./extension-bridge');

beforeEach(async () => {
  hooks.revoke.mockClear(); hooks.endCallsIn.mockClear();
  setExtensionBridgeHost({
    deliver: () => Promise.resolve(),
    selfGuguNumber: () => undefined, presentation: () => ({ locale: 'en', themeMode: 'dark' as const, fullscreen: false, windowFocused: true }),
  });
  await bindExtensionSurface({ webContentsId: PAGE, extensionId: 'workspace', tabId: 'slot-1', tabKind: 'workspace.main', conversation: CHAT });
});

it('the person taken out of the chat: its page there is revoked and its calls handed the chat lose it', async () => {
  await chatMembersChanged(CHAT, [{ memberId: ME, left: true }]);
  expect(hooks.revoke).toHaveBeenCalledWith(PAGE, 'removed-from-group');
  expect(hooks.endCallsIn).toHaveBeenCalledWith(CHAT, ME);
});

it('someone else leaving, or the person joining, takes nothing of this page', async () => {
  await chatMembersChanged(CHAT, [{ memberId: OTHER, left: true }, { memberId: ME, left: false }]);
  expect(hooks.revoke).not.toHaveBeenCalled();
  expect(hooks.endCallsIn).toHaveBeenCalledWith(CHAT, OTHER);
  expect(hooks.endCallsIn).not.toHaveBeenCalledWith(CHAT, ME);
});
