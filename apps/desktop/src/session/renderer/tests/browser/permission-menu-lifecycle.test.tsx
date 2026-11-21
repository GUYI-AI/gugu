import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { runInAction } from 'mobx';
import { afterEach, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
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

const active = vi.hoisted(() => ({
  store: null as unknown, source: null as unknown, agents: [] as AgentPayload[],
  read: vi.fn(), knownConnection: true,
}));
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
    models: [], agentDefault: null, sessionSelection: active.knownConnection ? null : undefined,
    catalogError: null, settled: true, retry: () => {}, refresh: () => {},
  }),
}));
Object.defineProperty(window, 'electronAPI', {
  configurable: true,
  value: {
    // The harness's own model catalog answers "not probed yet" (a catalog answer, ❌ an empty list in its place).
    invoke: async (channel: string, ...args: unknown[]) => channel === 'sessionTimeline.sessionCreateModels' ? active.read(...args)
      : channel === 'agents.modelCatalog' ? { state: { kind: 'unknown' }, refreshing: false } : [],
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
// The permission menu is an account replica: it reads while someone is signed in.
followRendererSession('SIGNED_IN', 'permission-menu-test');

afterEach(() => {
  root?.unmount(); container?.remove(); store?.dispose(); client?.clear(); replicaClient.clear();
  root = null; container = null; store = null; client = null;
  active.store = null; active.source = null; active.agents = []; active.read.mockReset(); active.knownConnection = true;
});

it.each(['running', 'stopped', 'disconnected'].flatMap(lifecycle =>
  ['allowed', 'native-denied', 'unreadable', 'connection-unknown'].map(qualification => ({ lifecycle, qualification }))
))('the real ACP panel keeps the complete menu for $lifecycle / $qualification', async ({ lifecycle, qualification }) => {
  registerSessionLocaleResources();
  setLocalePreference('zh-CN');
  await page.viewport(1100, 740);
  const id = 'permission-menu-' + lifecycle + '-' + qualification;
  active.knownConnection = qualification !== 'connection-unknown';
  active.agents = [{
    id: 'claude', name: 'Claude', status: 'available', reading: 'installed', command: 'claude',
    capabilities: {
      acp: { kind: 'supported', liveSettings: { permission: { channel: 'acp-config-option' } } },
      autoApprove: { kind: 'supported', modes: modeMap }, models: { kind: 'none' }, effort: { kind: 'none' },
      sessions: {}, sessionpage: { acp: { identity: 'addressable', messageTransport: 'router' } },
      auth: { kind: 'none' },
    },
  } as unknown as AgentPayload];
  active.source = { sessions: new Map([[id, {
    status: lifecycle === 'running' ? 'idle' : 'closed', markSeen: async () => {},
    data: { id, providerId: 'claude', model: 'opus', permissionMode: 'full-access', platformModel: null },
  }]]) };
  if (qualification === 'unreadable') active.read.mockRejectedValue(new Error('Native catalog unavailable'));
  else active.read.mockResolvedValue({
    ok: true, value: { permissionOptions: buildSessionPermissionOptions({ modeMap, native, review: { allowed: qualification === 'allowed', reason: 'taskConfig.reviewNativeUnavailable' } }) },
  });
  store = new AcpChatStore(id, 'project');
  active.store = store;
  const current = store;
  const internals = current as unknown as { _bootstrapped: boolean };
  runInAction(() => {
    internals._bootstrapped = true;
    current.historyLoading = false;
    if (lifecycle === 'running') current.session = {
      config: { current: () => ({
        modelOptions: { selected: 'opus', available: [{ id: 'opus', name: 'Opus 5.5' }] },
        modeOptions: { selected: 'bypassPermissions', available: native }, efforts: null, fastMode: null,
        availableCommands: [], acceptsImagePrompts: false,
      }) },
      sessionState: { current: () => ({
        lifecycle: 'ready', activeTurnId: null, pendingPermissions: [], queuedPrompts: [],
        isGenerating: false, canSubmit: true, canCancel: false,
      }) },
      usage: { current: () => null }, dispose: () => {},
    } as never;
    if (lifecycle === 'disconnected') current.reconcileAwaitingLink = true;
  });
  const submit = vi.spyOn(current, 'submitPrompt').mockResolvedValue();
  container = document.body.appendChild(document.createElement('div'));
  container.className = 'emlight gugu-skin';
  container.style.height = '700px';
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  root = createRoot(container);
  root.render(<LocalizationProvider><QueryClientProvider client={client}><MessageProvider locale="zh-CN" translate={translateSessionMessage}><AcpChatPanel /></MessageProvider></QueryClientProvider></LocalizationProvider>);
  if (active.knownConnection) await until('native qualification read', () => active.read.mock.calls.length > 0);
  await page.getByText('完全访问', { exact: true }).click();
  await until('permission menu appears', () => document.querySelector('[data-slot=combobox-content]') !== null);
  const rows = () => [...document.querySelectorAll('[role=option]')].filter(row => row.getBoundingClientRect().width > 0);
  expect(rows().map(row => row.textContent)).toEqual(['规划', '只读', '编辑', '自动模式', '完全访问']);
  await until('Auto reflects qualification', () => {
    const review = rows().find(row => row.textContent === '自动模式');
    return !!review && (review.getAttribute('aria-disabled') !== 'true') === (qualification === 'allowed');
  });
  if (active.knownConnection) expect(active.read.mock.calls[0][0]).toEqual({ harness: 'claude', sessionView: 'general', model: 'opus' });
  else expect(active.read).not.toHaveBeenCalled();
  expect(current.session !== null).toBe(lifecycle === 'running');
  expect(submit).not.toHaveBeenCalled();
});
