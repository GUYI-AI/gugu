import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * #1925 (API 46) How the person's click on the assistant in the host's row reaches the App: once, with the answer
 * `gugu.bindings.surface` gives now, in the one `onSurface` event to the page drawn beside the conversation — only while the
 * row may be drawn (`surfaceIntentHolds`, app-surface-header.test.ts) — never to a page an agent works, never in a later
 * event or answer. Without it the pages hear the answer alone.
 */
const sent = new Map<number, unknown[]>();
const contentsOf = (id: number) => ({
  id, isDestroyed: () => false, hostWebContents: { id: 42 }, session: { id }, once: () => undefined, on: () => undefined,
  send: (_channel: string, event: unknown) => sent.set(id, [...(sent.get(id) ?? []), event]),
});
vi.mock('electron', () => ({
  app: { getLocale: () => 'en-US' },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  webContents: { fromId: (id: number) => contentsOf(id) },
  shell: { openExternal: vi.fn() },
  clipboard: { writeText: vi.fn() },
}));
vi.mock('@main/lib/logger', () => ({ log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));
vi.mock('@main/core/extensions/extension-session', () => ({ extensionIdForSession: () => 'today', isExtensionSessionConfigured: () => true }));
vi.mock('@main/core/extensions/extension-background', () => ({ extensionBackgroundWebContentsId: () => null, runningExtensionBackgrounds: () => [] }));
vi.mock('@main/core/extensions/extension-programs', () => ({ extensionPrograms: {}, onExtensionProgramNotification: vi.fn() }));
const installed = vi.hoisted(() => ({ value: true }));
vi.mock('@main/core/extensions/extensions-root', () => ({
  extensionsService: () => ({
    get: () => ({ manifest: { id: 'today', name: 'Today', apiVersion: 46, contributes: { conversationSurface: { binding: 'main', placement: 'side-panel', header: 'assistant' } } } }),
    isInstalled: () => installed.value,
    isEnabled: () => true,
    hasCapability: () => true,
    grantedCapabilities: () => ['chat:unread', 'chat:surface'],
  }),
}));
const BOUND = { name: 'main', state: 'bound', layout: 'side-panel', panel: { collapsed: false, inset: { top: 52, right: 48 }, hostPage: false } } as const;
const verdict = vi.hoisted(() => ({ holds: true }));
const appBindingSurface = vi.fn(async (_id: string, page: { tabId: string }) => (page.tabId === 'dock' ? BOUND : { name: 'main', state: 'unbound' }));
const surfaceIntentHolds = vi.fn(async () => verdict.holds);
vi.mock('./app-unread-bindings', async (actual) => ({
  ...(await actual<typeof import('./app-unread-bindings')>()),
  appBindingSurface,
  surfaceIntentHolds,
  conversationSurfaceBinding: () => 'main',
}));
const { bindExtensionSurface, pushBindingSurfaces, unbindExtensionSurface } = await import('./extension-bridge');

const BESIDE = 81, ELSEWHERE = 82, AGENT_PAGE = 83;
const AGENT = { kind: 'agent', id: 'user:22000000-0000-4000-8000-000000000002' } as const;
const surfaceEvents = (id: number) => (sent.get(id) ?? []).filter((event) => (event as { type?: string }).type === 'bindingSurface');

beforeEach(async () => {
  sent.clear();
  installed.value = true;
  verdict.holds = true;
  appBindingSurface.mockClear();
  surfaceIntentHolds.mockClear();
  await bindExtensionSurface({ webContentsId: BESIDE, extensionId: 'today', tabId: 'dock', tabKind: 'today.main' });
  await bindExtensionSurface({ webContentsId: ELSEWHERE, extensionId: 'today', tabId: 'session-tab-7', tabKind: 'today.main' });
  await bindExtensionSurface({ webContentsId: AGENT_PAGE, extensionId: 'today', tabId: 'dock', tabKind: 'today.main', operator: AGENT });
  sent.clear();
  return () => { for (const id of [BESIDE, ELSEWHERE, AGENT_PAGE]) unbindExtensionSurface(id); };
});

describe('the click on the assistant, told to the App once', () => {
  it('to the page beside the conversation, with its answer now; elsewhere the answer alone; an agent\'s page nothing', async () => {
    await pushBindingSurfaces('today', { kind: 'profile' });
    expect(surfaceEvents(BESIDE)).toEqual([{ type: 'bindingSurface', surface: { ...BOUND, intent: { kind: 'profile' } } }]);
    expect(surfaceEvents(ELSEWHERE)).toEqual([{ type: 'bindingSurface', surface: { name: 'main', state: 'unbound' } }]);
    expect(surfaceEvents(AGENT_PAGE)).toEqual([]);
    // The next change is told without it: once is once.
    await pushBindingSurfaces('today');
    expect(surfaceEvents(BESIDE).at(-1)).toEqual({ type: 'bindingSurface', surface: BOUND });
    expect(surfaceIntentHolds).toHaveBeenCalledTimes(1);
  });

  it('while the row may not be drawn (not the assistant chat, not declared, changed): the answer alone', async () => {
    verdict.holds = false;
    await pushBindingSurfaces('today', { kind: 'profile' });
    expect(surfaceEvents(BESIDE)).toEqual([{ type: 'bindingSurface', surface: BOUND }]);
    expect(JSON.stringify(sent.get(BESIDE))).not.toContain('intent');
  });

  it('an App removed meanwhile is told nothing', async () => {
    installed.value = false;
    await pushBindingSurfaces('today', { kind: 'profile' });
    expect(sent.size).toBe(0);
    expect(surfaceIntentHolds).not.toHaveBeenCalled();
  });
});
