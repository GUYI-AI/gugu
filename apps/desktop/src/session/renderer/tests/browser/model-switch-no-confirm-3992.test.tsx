import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { runInAction } from 'mobx';
import { afterEach, expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { MessageProvider } from '@gugu/session-ui/react/components';
import { LocalizationProvider, setLocalePreference } from '@/i18n';
import { registerSessionLocaleResources, translateSessionMessage } from '@renderer/localization/locale-store';
import { buildSessionPermissionOptions } from '@shared/session-permission-options';
import { followRendererSession, queryClient as replicaClient } from '@/lib/replica';
import type { AgentPayload } from '@shared/core/agents/agent-payload';
import { until } from '../../../../../../../tests/support/awaitCondition';
import '@gugu/session-ui/styles/global';
import '@gugu/session-ui/theme/theme.css';
import '@gugu/session-ui/theme/semantic.css';
import '@gugu/session-ui/styles/base.css';
import '@/styles/tokens.css';
import '@renderer/index.css';

// #3992 owner 2026-11-26「直接省事不问就好了」: a model switch that needs a restart restarts at once, with no confirm
// dialog. The other restarts keep theirs: MCP toggle and permission here; the manual restart in session-actions.test.tsx.
// The panel is the real one; only the host seams are stubbed, and the host reload is a spy.
const active = vi.hoisted(() => ({
  store: null as unknown, source: null as unknown, agents: [] as AgentPayload[],
  reload: vi.fn(), read: vi.fn(),
}));
vi.mock('@renderer/features/sessions/request-session-reload', () => ({ requestSessionReload: active.reload }));
vi.mock('@renderer/features/tabs/pane-context', () => ({
  PaneContext: React.createContext(null),
  PaneProvider: ({ children }: { children: React.ReactNode }) => children,
  usePaneContext: () => ({ pane: { resolvedTabs: [{ isActive: true, kind: 'acp-chat', resource: { store: active.store } }] } }),
}));
vi.mock('@renderer/features/sessions/stores/session-registry', () => ({
  sessionRegistry: { get: () => active.source, allSessions: () => new Map() },
}));
vi.mock('@renderer/lib/chat/use-session-chat-layout', () => ({ useSessionChatLayout: () => ({ preset: 'single', userGutter: 0 }) }));
vi.mock('@renderer/features/integrations/use-connected-issue-providers', () => ({ useConnectedIssueProviders: () => ({ connectedProviders: [], isProviderUsable: () => false }) }));
vi.mock('@renderer/features/library/prompts/use-prompt-library', () => ({ usePromptLibrary: () => ({ value: [] }) }));
vi.mock('@renderer/lib/stores/use-agents', () => ({
  AGENTS_METADATA_QUERY_KEY: ['agents', 'metadata'],
  useAgents: () => ({ state: 'value', value: active.agents, stale: false, error: null }), useAgent: () => ({ state: 'unknown' }), useAgentIcon: () => undefined,
}));
vi.mock('@renderer/features/sessions/session-config/platform-model-catalog', async importOriginal => ({
  ...await importOriginal<typeof import('@renderer/features/sessions/session-config/platform-model-catalog')>(),
  usePlatformModelCatalog: () => ({
    models: [], agentDefault: null, sessionSelection: null, catalogError: null, settled: true, retry: () => {}, refresh: () => {},
  }),
}));
Object.defineProperty(window, 'electronAPI', {
  configurable: true,
  value: {
    invoke: async (channel: string, ...args: unknown[]) => channel === 'sessionTimeline.sessionCreateModels' ? active.read(...args)
      : channel === 'agents.modelCatalog' ? { state: { kind: 'unknown' }, refreshing: false }
      : channel === 'mcp.sessionPanel' ? { success: true, data: {
        servers: [{ name: 'github', enabled: true }], skills: [], toggleSupported: true, dialect: 'claude', granularity: 'per-server',
      } } : [],
    eventOn: () => () => {}, eventSend: () => {}, getPathForFile: () => '',
    subscribeAppActive: (listener: (active: boolean) => void) => { listener(true); return () => {}; },
  },
});
const { AcpChatStore } = await import('@renderer/features/sessions/acp/acp-chat-store');
const { AcpChatPanel } = await import('@renderer/features/sessions/acp/acp-chat-panel');
const modeMap = {
  plan: { id: 'plan' }, 'read-only': { id: 'default' }, edit: { id: 'acceptEdits' },
  'ai-review': { id: 'auto' }, 'full-access': { id: 'bypassPermissions' },
};
const native = Object.values(modeMap).map(({ id }) => ({ id, name: id }));
let root: Root | null = null;
let container: HTMLDivElement | null = null;
let store: InstanceType<typeof AcpChatStore> | null = null;
let client: QueryClient | null = null;
followRendererSession('SIGNED_IN', 'model-switch-no-confirm-test');

afterEach(() => {
  root?.unmount(); container?.remove(); store?.dispose(); client?.clear(); replicaClient.clear();
  root = null; container = null; store = null; client = null;
  active.store = null; active.source = null; active.agents = []; active.reload.mockReset(); active.read.mockReset();
});

/** A running Claude-shaped session whose model and permission both change only by restarting the session. */
async function mountRunningSession(id: string) {
  registerSessionLocaleResources();
  setLocalePreference('zh-CN');
  await page.viewport(1100, 740);
  active.agents = [{
    id: 'claude', name: 'Claude', status: 'available', reading: 'installed', command: 'claude',
    capabilities: {
      acp: { kind: 'supported', liveSettings: { model: { channel: 'reload-session' }, permission: { channel: 'reload-session' } } },
      autoApprove: { kind: 'supported', modes: modeMap }, models: { kind: 'none' }, effort: { kind: 'none' },
      sessions: {}, sessionpage: { acp: { identity: 'addressable', messageTransport: 'router' } },
      auth: { kind: 'none' },
    },
  } as unknown as AgentPayload];
  active.source = { sessions: new Map([[id, {
    status: 'idle', markSeen: async () => {},
    data: { id, providerId: 'claude', providerSessionId: `provider-${id}`, model: 'opus', permissionMode: 'full-access', platformModel: null },
  }]]) };
  active.read.mockResolvedValue({
    ok: true, value: { permissionOptions: buildSessionPermissionOptions({ modeMap, native, review: { allowed: true, reason: 'taskConfig.reviewNativeUnavailable' } }) },
  });
  active.reload.mockResolvedValue({ ok: true });
  store = new AcpChatStore(id, 'project');
  active.store = store;
  const current = store;
  runInAction(() => {
    (current as unknown as { _bootstrapped: boolean })._bootstrapped = true;
    current.historyLoading = false;
    current.session = {
      config: { current: () => ({
        modelOptions: { selected: 'opus', available: [{ id: 'opus', name: 'Opus 5.5' }, { id: 'sonnet', name: 'Sonnet 5.5' }] },
        modeOptions: { selected: 'bypassPermissions', available: native }, efforts: null, fastMode: null,
        availableCommands: [], acceptsImagePrompts: false,
      }) },
      sessionState: { current: () => ({
        lifecycle: 'ready', activeTurnId: null, pendingPermissions: [], queuedPrompts: [],
        isGenerating: false, canSubmit: true, canCancel: false,
      }) },
      activeTurn: { current: () => null }, canSyncDraft: () => false,
      usage: { current: () => null }, dispose: () => {},
    } as never;
  });
  container = document.body.appendChild(document.createElement('div'));
  container.className = 'emlight gugu-skin';
  container.style.height = '700px';
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  root = createRoot(container);
  root.render(<LocalizationProvider><QueryClientProvider client={client}><MessageProvider locale="zh-CN" translate={translateSessionMessage}><AcpChatPanel /></MessageProvider></QueryClientProvider></LocalizationProvider>);
  return current;
}
const visibleRows = () => [...document.querySelectorAll('[role=option]')].filter(row => row.getBoundingClientRect().width > 0) as HTMLElement[];
// The restart confirm is `SessionReloadConfirm` → `ConfirmationDialog`; its confirm button is the one marker it owns.
const confirmDialog = () => document.querySelector('[data-testid=confirmation-dialog-confirm]');

it('an idle model switch that needs a restart restarts at once, with no confirm dialog', async () => {
  const id = 'model-switch-no-confirm-3992';
  await mountRunningSession(id);
  await page.getByTestId('composer-model-trigger').click();
  await until('model menu lists the other model', () => visibleRows().some(row => row.textContent?.includes('Sonnet 5.5')));
  visibleRows().find(row => row.textContent?.includes('Sonnet 5.5'))!.click();
  await until('the restart is requested', () => active.reload.mock.calls.length > 0);
  expect(active.reload.mock.calls[0][0]).toMatchObject({ sessionId: id, model: 'sonnet' });
  expect(confirmDialog()).toBeNull();
});

it('a permission change that needs a restart still asks first', async () => {
  const current = await mountRunningSession('permission-still-asks-3992');
  vi.spyOn(current, 'setMode').mockResolvedValue({ kind: 'restart-required', requestedValue: 'acceptEdits' } as never);
  await until('native qualification read', () => active.read.mock.calls.length > 0);
  await page.getByText('完全访问', { exact: true }).click();
  await until('permission menu appears', () => visibleRows().some(row => row.textContent === '编辑'));
  visibleRows().find(row => row.textContent === '编辑')!.click();
  await until('the restart confirm opens', () => confirmDialog() !== null);
  expect(document.body.textContent).toContain('将权限切换为「编辑」');
  expect(active.reload).not.toHaveBeenCalled();
});

it('an MCP toggle still asks before restarting', async () => {
  await mountRunningSession('mcp-still-asks-3992');
  await page.getByTestId('prompt-editor').click();
  await userEvent.keyboard('/mcp');
  await until('the /mcp command is offered', () => visibleRows().some(row => /\/mcp/.test(row.textContent ?? '')));
  await userEvent.click(visibleRows().find(row => /\/mcp/.test(row.textContent ?? ''))!);
  await until('the MCP panel opens', () => document.querySelector('[data-testid=mcp-session-switch-github]') !== null);
  await page.getByTestId('mcp-session-switch-github').click();
  await page.getByTestId('mcp-session-apply').click();
  await until('the restart confirm opens', () => confirmDialog() !== null);
  expect(active.reload).not.toHaveBeenCalled();
});
