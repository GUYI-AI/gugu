// @vitest-environment jsdom
import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * #1925 (API 44) What the session page hands main for an App's `status`: each of the panel's numbers as a read state
 * (ready / loading / unreadable — never 0 for the last two), and the connect step's list (in its order, the host's own
 * marks as data: images, connected or not, no account). A connect from the App opens the built-in connect dialog of that
 * one service, for the account and the list the window shows.
 */
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const D = '../../../../apps/desktop/src';
const reads = vi.hoisted(() => ({
  apps: { state: 'loading' } as Record<string, unknown>,
  chat: { status: 'ready', list: [] } as Record<string, unknown>,
  capabilities: 'loading' as number | 'loading' | 'failed',
  machine: { data: { panel: {} }, isLoading: false, error: null } as Record<string, unknown>,
  pushes: [] as Record<string, unknown>[],
  opened: [] as string[],
}));
vi.mock('react-i18next', async (original) => ({ ...(await original<object>()), useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }) }));
vi.mock('../../../../apps/desktop/src/mobile/assistant/usePhoneRead', () => ({ usePhoneRead: () => reads.apps }));
vi.mock('../../../../apps/desktop/src/components/assistant/assistant-panel-integrations', () => ({ readAssistantPanelIntegrations: vi.fn(), peekAssistantPanelIntegrations: vi.fn() }));
vi.mock('../../../../apps/desktop/src/components/settings/channels/useChatChannels', () => ({ useChatChannels: () => reads.chat }));
vi.mock('../../../../apps/desktop/src/components/assistant/assistant-app-connections', () => ({ assistantApplicationCounts: () => ({ saved: 2, connected: 1 }) }));
vi.mock('../../../../apps/desktop/src/components/assistant/AssistantLibraryVolume', () => ({
  AssistantLibraryCount: ({ onCount }: { onCount: (read: unknown) => void }) => {
    useEffect(() => onCount(reads.capabilities));
    return null;
  },
}));
vi.mock('../../../../apps/desktop/src/platform', () => ({ platform: { capabilities: { agentRuntime: true } } }));
vi.mock('../../../../apps/desktop/src/session/renderer/lib/stores/app-state', () => ({ appState: { sidebar: { orderedProjects: [{}, {}, {}] } } }));
vi.mock('../../../../apps/desktop/src/session/renderer/lib/ipc', () => ({ rpc: { extensions: {
  assistantCountsChanged: async (args: Record<string, unknown>) => { reads.pushes.push(args); return { success: true }; },
} } }));
vi.mock('../../../../apps/desktop/src/session/renderer/utils/logger', () => ({ log: { warn: vi.fn() } }));
vi.mock('../../../../apps/desktop/src/session/renderer/features/assistant/assistant-data', () => ({ useAssistantMachine: () => reads.machine }));
vi.mock('../../../../apps/desktop/src/session/renderer/features/assistant/assistant-home-integrations', () => ({
  useOpenConnector: () => (id: string) => { reads.opened.push(id); },
}));
vi.mock('../../../../apps/desktop/src/lib/myAssistant', () => ({ isMyAssistant: () => false }));

const { installAssistantShellBridge, publishAssistantShell } = await import(`${D}/lib/assistantShellBridge`);
const { AssistantAppCountsSource, connectorIconOf, openAssistantConnector, resetAssistantAppCountsForTest } = await import(`${D}/session/renderer/features/apps/assistant-app-counts`);
const { integrationIcons } = await import('@gugu/session-plugins/integration-icons');

const OWNER = '11000000-0000-4000-8000-000000000001';
const OTHER = '22000000-0000-4000-8000-000000000002';
const DEVICE = '55000000-0000-4000-8000-000000000005';
const shell = (over: Record<string, unknown> = {}) => ({
  cloudAvailable: true, canHostHere: true, cloud: null, loadError: null,
  assistant: { id: '44000000-0000-4000-8000-000000000004', display_name: 'Dot', avatar: null, created_at: null },
  assistantState: 'found', ownerName: 'Ann', deviceCount: 2, ownerId: OWNER, ownerAvatar: null, chatId: 'chat-1', chatReadFailed: false,
  home: { kind: 'computer', deviceId: DEVICE, thisDevice: true, label: 'Studio', online: true, known: true }, setup: 'connect', member: null, preparing: false, ...over,
}) as never;
const ITEMS = [
  { id: 'github', name: 'GitHub', description: 'Code' },
  { id: 'feishu', name: 'Feishu', description: 'Docs' },
];
const ok = (configured: Record<string, unknown> = { github: { id: 'acct-1', displayName: 'ann@example.com' } }) =>
  ({ state: 'ok', data: { items: ITEMS, configured, statuses: { github: { connected: true, displayName: 'ann@example.com' } } } });

let root: Root;
let container: HTMLDivElement;
const mount = () => act(() => root.render(<AssistantAppCountsSource />));
const last = () => reads.pushes.at(-1) as { ownerId: string; counts: Record<string, unknown>; connectors: { state: string; value?: { id: string; connected: boolean; icon: unknown }[] } };

beforeEach(() => {
  resetAssistantAppCountsForTest();
  Object.assign(reads, {
    apps: { state: 'loading' }, chat: { status: 'ready', list: [] }, capabilities: 'loading',
    machine: { data: { panel: {} }, isLoading: false, error: null }, pushes: [], opened: [],
  });
  installAssistantShellBridge();
  publishAssistantShell(shell());
  container = document.body.appendChild(document.createElement('div'));
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('the counts as read states', () => {
  it('ready with the number, loading while it reads — never 0 for it', () => {
    mount();
    expect(last().counts).toEqual({ devices: { state: 'ready', value: 2 }, connectedApps: { state: 'loading' }, projects: { state: 'ready', value: 3 }, capabilities: { state: 'loading' } });
    expect(last().connectors).toEqual({ state: 'loading' });
    reads.apps = ok();
    reads.capabilities = 5;
    act(() => publishAssistantShell(shell({ deviceCount: 4 })));
    mount();
    expect(last().counts).toEqual({ devices: { state: 'ready', value: 4 }, connectedApps: { state: 'ready', value: { saved: 2, connected: 1 } }, projects: { state: 'ready', value: 3 }, capabilities: { state: 'ready', value: 5 } });
  });

  // Owner 11-12 (fresh account): right after setup the cloud had not prepared the panel's collections yet; that is still
  // coming, not 「暂时读不到资源」.
  it('a collection not prepared yet is loading, never unreadable', () => {
    reads.apps = { state: 'error', error: Object.assign(new Error('This collection has not been prepared yet'), { code: 'unprepared' }) };
    mount();
    expect(last().counts).toMatchObject({ connectedApps: { state: 'loading' } });
    expect(last().connectors).toEqual({ state: 'loading' });
  });

  it('unreadable where the built-in row says it cannot read: the library, the connections, the chat channels, the panel itself', () => {
    reads.capabilities = 'failed';
    reads.apps = { state: 'error' };
    mount();
    expect(last().counts).toMatchObject({ connectedApps: { state: 'unreadable' }, capabilities: { state: 'unreadable' } });
    expect(last().connectors).toEqual({ state: 'unreadable' });
    act(() => root.unmount());
    root = createRoot(container);
    resetAssistantAppCountsForTest();
    reads.pushes = [];
    reads.apps = ok();
    reads.chat = { status: 'failed', list: [] };
    reads.capabilities = 5;
    mount();
    expect(last().counts).toMatchObject({ connectedApps: { state: 'unreadable' }, capabilities: { state: 'ready', value: 5 } });
    act(() => root.unmount());
    root = createRoot(container);
    resetAssistantAppCountsForTest();
    reads.pushes = [];
    reads.chat = { status: 'ready', list: [] };
    reads.machine = { data: undefined, isLoading: false, error: new Error('PANEL_IDENTITY_UNAVAILABLE') };
    reads.apps = { state: 'loading' };
    reads.capabilities = 'loading';
    mount();
    expect(last().counts).toMatchObject({ connectedApps: { state: 'unreadable' }, capabilities: { state: 'unreadable' } });
    expect(last().connectors).toEqual({ state: 'unreadable' });
  });

  it('nothing handed over while the window shows no assistant', () => {
    publishAssistantShell(shell({ assistantState: 'none', assistant: null, home: null }));
    mount();
    expect(reads.pushes).toEqual([]);
  });
});

describe('the connect step\'s list', () => {
  it('in the step\'s order, the host\'s marks as data: images, connected or not — no account, address or description', () => {
    reads.apps = ok();
    mount();
    const { connectors } = last();
    expect(connectors.state).toBe('ready');
    expect(connectors.value!.map((row) => [row.id, row.connected])).toEqual([['github', true], ['feishu', false]]);
    const said = JSON.stringify(connectors);
    for (const secret of ['acct-1', 'ann@example.com', 'Code', 'Docs', 'https:']) expect(said).not.toContain(secret);
    expect(connectors.value![0]!.icon).toMatchObject({ light: expect.stringMatching(/^data:image\/svg\+xml;base64,/), dark: expect.stringMatching(/^data:image\/svg\+xml;base64,/) });
  });

  it('a mark: the svg art as its own image; an image that is not data: is none', () => {
    const github = connectorIconOf(integrationIcons.github)!;
    expect(atob(github.light.split(',')[1]!)).toContain('<svg');
    expect(connectorIconOf({ kind: 'image', variants: [{ minSize: 0, light: 'https://example.com/a.png' }] } as never)).toBeNull();
    expect(connectorIconOf({ kind: 'image', variants: [{ minSize: 0, light: 'data:image/png;base64,iVBO' }], invertInDark: true } as never))
      .toEqual({ light: 'data:image/png;base64,iVBO', dark: null, invertInDark: true });
    expect(connectorIconOf(undefined)).toBeNull();
  });
});

describe('a connect from the App', () => {
  it('opens that service\'s connect dialog, as the built-in step\'s click', () => {
    reads.apps = ok();
    mount();
    openAssistantConnector('feishu', OWNER);
    expect(reads.opened).toEqual(['feishu']);
  });

  it('refused, opening nothing: another account, a service not in the list, no assistant shown, no panel on screen', () => {
    reads.apps = ok();
    mount();
    expect(() => openAssistantConnector('feishu', OTHER)).toThrow();
    expect(() => openAssistantConnector('notion', OWNER)).toThrow();
    // The window switched account (or the assistant went) a moment ago, before the page drew again: the old account's
    // dialog and list are still held, and refused all the same.
    publishAssistantShell(shell({ ownerId: OTHER }));
    expect(() => openAssistantConnector('feishu', OTHER)).toThrow();
    publishAssistantShell(shell({ assistantState: 'none', assistant: null }));
    expect(() => openAssistantConnector('feishu', OWNER)).toThrow();
    act(() => publishAssistantShell(shell({ assistantState: 'none', assistant: null })));
    expect(() => openAssistantConnector('feishu', OWNER)).toThrow();
    act(() => publishAssistantShell(shell()));
    act(() => root.unmount());
    expect(() => openAssistantConnector('feishu', OWNER)).toThrow();
    root = createRoot(container);
    expect(reads.opened).toEqual([]);
  });
});
