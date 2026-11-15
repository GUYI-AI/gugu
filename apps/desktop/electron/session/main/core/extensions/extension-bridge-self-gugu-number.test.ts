import { describe, expect, it, vi } from 'vitest';
import type { ExtensionBridgeResponse, ExtensionHostContext } from '@shared/extensions/bridge-protocol';

/** API 32: a person's page reads its person's own 咕咕号 in `operator`; an agent's page is told nothing new. */

const contents = new Map([1, 2].map((id) => [id, {
  id, session: { extensionId: 'board' }, hostWebContents: { id: 42 }, isDestroyed: () => false, on: vi.fn(), once: vi.fn(), send: vi.fn(),
}]));
const handlers = new Map<string, (event: unknown, args: unknown) => Promise<ExtensionBridgeResponse>>();
vi.mock('electron', () => ({
  ipcMain: { handle: (name: string, fn: (event: unknown, args: unknown) => Promise<ExtensionBridgeResponse>) => handlers.set(name, fn), on: vi.fn() },
  webContents: { fromId: (id: number) => contents.get(id) },
}));
vi.mock('@main/core/extensions/extension-session', () => ({ extensionIdForSession: (session: { extensionId: string }) => session.extensionId, isExtensionSessionConfigured: () => true }));
vi.mock('@main/core/extensions/extension-background', () => ({ extensionBackgroundWebContentsId: () => null }));
vi.mock('@main/core/extensions/extensions-root', () => ({
  extensionsService: () => ({ grantedCapabilities: () => [], hasCapability: () => false, get: () => ({ manifest: { name: 'Board', defaultLocale: 'en' } }) }),
}));
vi.mock('@main/lib/logger', () => ({ log: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));

const { bindExtensionSurface, registerExtensionBridge, setExtensionBridgeHost } = await import('./extension-bridge');
const { EXTENSION_BRIDGE_CHANNEL } = await import('@shared/extensions/bridge-protocol');
registerExtensionBridge();
let own: number | null | undefined;
setExtensionBridgeHost({
  deliver: async () => undefined,
  selfGuguNumber: () => own,
  presentation: () => ({ locale: 'en', themeMode: 'light', fullscreen: false, windowFocused: true }),
});
const operatorOf = async (page: number) => {
  const reply = await handlers.get(EXTENSION_BRIDGE_CHANNEL)!({ sender: contents.get(page) }, { method: 'getContext', args: {} });
  if (!reply.ok) throw new Error(reply.message);
  return (reply.value as ExtensionHostContext).operator;
};
await bindExtensionSurface({ webContentsId: 1, extensionId: 'board', tabId: 'slot', tabKind: 'board.main' });
await bindExtensionSurface({ webContentsId: 2, extensionId: 'board', tabId: 'check', tabKind: 'board.main', operator: { kind: 'agent', id: 'user:agent-a' } });

describe("a person's page and their own 咕咕号", () => {
  it('is absent until known, then the number, and null when it could not be read', async () => {
    own = undefined;
    expect(await operatorOf(1)).toEqual({ kind: 'person' });
    own = 100023;
    expect(await operatorOf(1)).toEqual({ kind: 'person', guguNumber: 100023 });
    own = null;
    expect(await operatorOf(1)).toEqual({ kind: 'person', guguNumber: null });
  });

  it("is not on an agent's page", async () => {
    own = 100023;
    expect(await operatorOf(2)).toEqual({ kind: 'agent', id: 'user:agent-a' });
  });
});
