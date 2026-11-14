import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { AuthStatusModelState } from '@gugu/session-core/workspace-server/agent-config';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentCapabilities, AgentPayload } from '@shared/core/agents/agent-payload';
import { AgentAccountSection } from './AgentAccountSection';
import { LibraryHostProvider, type LibraryHost } from '@renderer/features/library/library-host';

const mocks = vi.hoisted(() => ({
  auth: null as AuthStatusModelState | null,
  /** 按程序给不同读数(#6335);没给的程序用上面那份。 */
  authByProgram: {} as Record<string, AuthStatusModelState | null>,
  statusCalls: [] as Array<[string, string | undefined]>,
  statusOptions: [] as unknown[],
  refreshAuth: vi.fn(),
  refreshCatalog: vi.fn(),
  invalidate: vi.fn(),
  signIn: vi.fn(),
  /** 这一家在咕咕网关上有几个模型(与新建框同一份目录)。 */
  platformModels: [] as unknown[],
  /** 「订阅」页那份套餐读数(资源库这一行与它同一份)。 */
  plan: undefined as unknown,
  planCalls: [] as Array<[string | null, string]>,
}));

vi.mock('@renderer/lib/ipc', () => ({ rpc: { agents: {}, mcp: {} }, events: { on: () => () => {} } }));

vi.mock('@renderer/lib/stores/use-agent-auth-status', () => ({
  useAgentAuthStatus: () => ({ auth: mocks.auth, refresh: mocks.refreshAuth }),
  useAgentAuthStatuses: (providerId: string, programs: Array<string | undefined>, options?: unknown) => {
    mocks.statusOptions.push(options);
    for (const program of programs) mocks.statusCalls.push([providerId, program]);
    return {
      auths: programs.map((program) =>
        program !== undefined && program in mocks.authByProgram ? mocks.authByProgram[program] : mocks.auth
      ),
      refresh: mocks.refreshAuth,
    };
  },
}));
// ⚠️ 这里 mock 的是**函数**而不是 hook,而那正是本次的要点:抽屉只要「让目录作废」这一下,
// ❌ 不订阅目录 —— 订阅会顺带起一个 harness 进程去探,打开任意一家的抽屉都要付这笔钱。
vi.mock('@renderer/lib/stores/use-harness-model-catalog', () => ({
  forceRefreshHarnessModelCatalog: mocks.refreshCatalog,
}));
vi.mock('@renderer/features/sessions/session-config/platform-model-catalog', () => ({
  usePlatformModelCatalog: () => ({ models: mocks.platformModels }),
}));
vi.mock('@renderer/lib/stores/use-harness-model-credential', () => ({
  harnessModelCredentialKey: (providerId: string) => ['agents', 'modelCredential', providerId],
}));
vi.mock('@renderer/features/settings/subscriptions/subscription-queries', async importOriginal => ({
  ...(await importOriginal<typeof import('@renderer/features/settings/subscriptions/subscription-queries')>()),
  subscriptionKey: (machine: string | null, agentId?: string) => ['subscriptions', machine ?? 'local', ...(agentId ? [agentId] : [])],
  useSubscriptionPlan: (machine: string | null, agentId: string) => {
    mocks.planCalls.push([machine, agentId]);
    return { data: mocks.plan };
  },
}));
vi.mock('@renderer/lib/agent-config/runtime-client', () => ({
  getAgentConfigRuntimeClient: async () => ({
    refreshAuthStatus: async () => ({ success: true, data: mocks.auth?.status ?? { kind: 'unknown' } }),
    listConnections: async () => ({ success: true, data: [{ id: 'native', kind: 'native', name: 'CLI', current: true }] }),
    readSubscription: async () => ({ success: true, data: { payer: 'not-signed-in' } }),
  }),
}));
vi.mock('@renderer/lib/modal/modal-provider', () => ({ useShowModal: () => mocks.signIn }));
vi.mock('@renderer/localization/use-session-messages', () => ({
  useSessionMessages: () => ({
    translate: (key: string, values?: Record<string, string>) =>
      values ? `${key}:${Object.values(values).join(',')}` : key,
  }),
}));
vi.mock('@renderer/lib/ui/field', () => ({
  Field: ({ children }: { children: React.ReactNode }) => React.createElement('div', null, children),
}));
vi.mock('@renderer/lib/ui/label', () => ({
  Label: ({ children }: { children: React.ReactNode }) => React.createElement('span', null, children),
}));
vi.mock('@renderer/lib/ui/button', () => ({
  Button: ({
    children,
    ...props
  }: { children: React.ReactNode } & React.ButtonHTMLAttributes<HTMLButtonElement>) =>
    React.createElement('button', props, children),
}));

const CLI_LOGIN: AgentCapabilities['auth'] = {
  kind: 'supported',
  methods: [
    { kind: 'cli-login', id: 'claude-login', name: 'Sign in with Claude', args: ['auth', 'login'] },
  ],
};

const ACP_AUTH: AgentCapabilities['auth'] = {
  kind: 'supported',
  methods: [
    { kind: 'acp-authenticate', id: 'google', name: 'Google 账号', methodId: 'oauth-personal' },
  ],
};

const agent = (auth: AgentCapabilities['auth'], status: AgentPayload['status'] = 'available') =>
  ({
    id: 'test-cli',
    name: 'Test CLI',
    status,
    capabilities: { auth } as AgentCapabilities,
  }) as unknown as AgentPayload;

describe('AgentAccountSection', () => {
  let dom: JSDOM;
  let root: Root;
  let container: HTMLDivElement;
  let client: QueryClient;

  const render = async (payload: AgentPayload, host?: LibraryHost) => {
    await act(async () => {
      const section = React.createElement(AgentAccountSection, { agent: payload });
      root.render(React.createElement(QueryClientProvider, { client }, host ? React.createElement(LibraryHostProvider, { value: host }, section) : section));
    });
  };

  beforeEach(() => {
    dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>');
    vi.stubGlobal('window', dom.window);
    vi.stubGlobal('document', dom.window.document);
    vi.stubGlobal('HTMLElement', dom.window.HTMLElement);
    for (const key of ['Element', 'Node', 'CustomEvent', 'MutationObserver'] as const) vi.stubGlobal(key, dom.window[key]);
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    container = dom.window.document.getElementById('root') as HTMLDivElement;
    root = createRoot(container);
    client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    vi.spyOn(client, 'invalidateQueries').mockImplementation(mocks.invalidate);
    mocks.auth = null;
    mocks.authByProgram = {};
    mocks.statusCalls = [];
    mocks.statusOptions = [];
    mocks.refreshAuth.mockClear();
    mocks.refreshCatalog.mockClear();
    mocks.invalidate.mockClear();
    mocks.signIn.mockClear();
    mocks.platformModels = [];
    mocks.plan = undefined;
    mocks.planCalls = [];
  });

  afterEach(() => {
    act(() => root.unmount());
    client.clear();
    vi.unstubAllGlobals();
  });

  it('只声明 api-key 的家:一个字都不画', async () => {
    mocks.auth = { status: { kind: 'unauthenticated' }, login: null };
    await render(
      agent({
        kind: 'supported',
        methods: [
          {
            kind: 'api-key',
            id: 'gemini-api-key',
            name: 'Use a Gemini API key',
            envVars: [{ name: 'GEMINI_API_KEY', label: 'Gemini API key' }],
          },
        ],
      })
    );
    expect(container.textContent).toBe('');
  });

  it('没声明 auth 的家:一个字都不画', async () => {
    mocks.auth = { status: { kind: 'unauthenticated' }, login: null };
    await render(agent({ kind: 'none' }));
    expect(container.textContent).toBe('');
  });

  const connectionBlock = async (id: string) => {
    await act(async () => {
      await vi.waitFor(() => expect(container.querySelector(`[data-testid="subscription-no-connection-${id}"]`)).not.toBeNull());
    });
  };

  /**
   * #2507 owner 2026-11-12:「任意 agent 都能有登录选项」「你非得每个都不一样干嘛」—— 每一家都是同一块「连接」:
   * 当前连接 + 添加连接(与订阅页那一行同一块)。从前 Claude / Codex 一种、其余家一行「账号 · 登录」,现在只有一种。
   */
  it.each([{ provider: 'claude', declared: false }, { provider: 'claude', declared: true }, { provider: 'codex', declared: false }, { provider: 'codex', declared: true }])('$provider declared=$declared: native 未登录时不列、写「没有」,添加连接就地给;❌ 把用户送进会被拒绝的 native 登录', async ({ provider, declared }) => {
    mocks.auth = { status: { kind: 'unauthenticated' }, login: null };
    await render({ ...agent({ ...CLI_LOGIN, ...(declared ? { connections: { kind: 'managed' as const } } : {}) }), id: provider, name: provider });
    await connectionBlock(provider);
    expect(container.querySelector(`[data-testid="subscription-add-${provider}"]`)).not.toBeNull();
    expect(container.textContent).not.toContain('subscriptions.connections.existing');
    expect(container.querySelector('[data-testid="agent-account-sign-in"]')).toBeNull();
    expect(mocks.signIn).not.toHaveBeenCalled();
  });

  it.each([['cli-login', CLI_LOGIN], ['acp-authenticate', ACP_AUTH]] as const)('声明了 %s 的家:同一块「连接」,❌ 另一行「账号 · 登录」', async (_kind, auth) => {
    mocks.auth = { status: { kind: 'unauthenticated' }, login: null };
    await render(agent(auth));
    await connectionBlock('test-cli');
    expect(container.querySelectorAll('[data-testid="connection-block-test-cli"]')).toHaveLength(1);
    expect(container.querySelector('[data-testid="subscription-add-test-cli"]')).not.toBeNull();
    // 只有账号登录(没接 Key):添加连接下面那行照实写。
    expect(container.textContent).toContain('agentsPage.connectionAddHintAccount');
    expect(container.querySelector('[data-testid="agent-account-status"]')).toBeNull();
    expect(container.querySelector('[data-testid="agent-account-sign-in"]')).toBeNull();
  });

  it('只接 API Key 的家(Pi):同一块「连接」,添加连接只写 API Key', async () => {
    await render({
      ...agent({ kind: 'none' }),
      id: 'pi',
      capabilities: { auth: { kind: 'none' }, apiKeyConnection: { kind: 'supported', endpoint: 'required', model: 'required', evidence: 'test' } },
    } as unknown as AgentPayload);
    await connectionBlock('pi');
    expect(container.textContent).toContain('agentsPage.connectionAddHintApiKey');
  });
});
