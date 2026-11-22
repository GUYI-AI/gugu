import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { until, untilStable } from '../../../../../../../tests/support/awaitCondition';
import { SessionSettingsContent } from '@renderer/features/settings/components/SettingsPage';
import { CustomModelsGroup } from '@/components/settings/CustomModelsGroup';
import { GuguSubscriptionRow } from '@renderer/features/settings/subscriptions/GuguSubscriptionRow';
import { AgentDetailModal } from '@renderer/features/settings/agents-page/AgentDetailModal';
import { AgentConnectionDetails } from '@renderer/features/settings/agents-page/AgentConnectionDetails';
import { agentOffersConnections } from '@renderer/features/settings/agents-page/agent-account';
import { useManagementAgents } from '@renderer/lib/stores/use-agents';
import { UiPortalContainerProvider } from '@gugu/session-ui/react/primitives';
import { useLayoutEffect } from 'react';
import { SessionLocalizationProvider } from '@renderer/localization/localization-provider';
import { QueryClientProvider } from '@tanstack/react-query';
import { followRendererSession, queryClient } from '@/lib/replica';
import { setLocalePreference } from '@/i18n';
import type { AgentHomeScan, HarnessConnection } from '@gugu/session-core/workspace-server/agent-config';
import { modalStore } from '@renderer/lib/modal/modal-store';
import '@/styles/tokens.css';
import '@renderer/index.css';
import '@/components/settings/ModelSettings.css';

const CLAUDE = { id: 'claude', name: 'Claude Code', reading: 'installed', status: 'available', capabilities: { auth: { kind: 'supported', methods: [{ kind: 'cli-login', id: 'claude-login', name: 'Claude', args: ['auth', 'login'] }] } } };
// #2507 其他家:Kimi 能在产品里登录(cli-login),Pi 没有任何登录方法。
const KIMI = { id: 'kimi', name: 'Kimi', reading: 'installed', status: 'available', capabilities: { auth: { kind: 'supported', methods: [{ kind: 'cli-login', id: 'kimi-login', name: 'Kimi', args: ['login'] }] } } };
const PI = { id: 'pi', name: 'Pi', reading: 'installed', status: 'available', capabilities: {} };
const QWEN = { id: 'qwen', name: 'Qwen Code', reading: 'installed', status: 'available', capabilities: {} };
const KIRO = { id: 'kiro', name: 'Kiro', reading: 'installed', status: 'available', capabilities: {
  auth: { kind: 'supported', methods: [{ kind: 'cli-login', id: 'kiro-login', name: 'Kiro', args: ['login'] }] },
} };
// MiMo keeps its CLI account and vendor key in the same connection block.
const MIMO = { id: 'mimocode', name: 'MiMo Code', reading: 'installed', status: 'available', capabilities: {
  auth: { kind: 'supported', methods: [{ kind: 'cli-login', id: 'mimo-login', name: 'MiMo', args: ['auth', 'login'] }], vendorKey: { envVars: ['XIAOMI_API_KEY'], unsetEnv: ['XIAOMI_API_KEY'] } },
} };
// 有图标才会画到真正读主题的那一层(没图标时 AppIcon 只画一块底色)。
const ICONS = {
  claude: { kind: 'svg', variants: [{ minSize: 0, light: '<svg viewBox="0 0 1 1"></svg>' }], plate: { color: '#D97757', mark: 'white' } },
};

// 宿主只答「这台机器装了哪些 agent」;其余调用挂起不回(❌ 抛错 —— 抛错会落成测试之外的未处理错误)。
vi.mock('@renderer/lib/ipc', async (importOriginal) => {
  const pending = () => new Promise(() => {});
  const answers: Record<string, (...args: never[]) => Promise<unknown>> = {
    listManagement: async () => [
      CLAUDE,
      ...(control.codex ? [{ id: 'codex', name: 'Codex', reading: 'installed', status: 'available', capabilities: CLAUDE.capabilities }] : []),
      ...(control.others ? [KIMI, PI] : []),
      ...(control.keyed ? [QWEN, KIRO, MIMO] : []),
    ].map(agent => ({
      installOptions: [],
      ...agent,
      // 资源库详情画安装那一格要的几样(订阅页不读)。
      capabilities: {
        hostDependency: { updates: { kind: 'none' }, uninstall: { kind: 'none' } },
        hooks: { kind: 'none' },
        sessions: { kind: 'stateless' },
        ...agent.capabilities,
      },
    })),
    list: async () => answers.listManagement!(),
    listIcons: async () => ICONS,
    modelCatalog: async () => ({ state: { kind: 'ready', models: [] }, refreshing: false }),
    // 资源库详情(与订阅页同一块「连接」,#2507)。
    getManagement: async (id: string) =>
      (await answers.listManagement!() as Array<{ id: string }>).find(candidate => candidate.id === id) ?? null,
    listAgentInstallationStatus: async () => [],
    getSettings: async () => null,
  };
  const agents = new Proxy({}, { get: (_, key) => answers[String(key)] ?? pending });
  const namespace = new Proxy({}, { get: () => pending });
  const original = await importOriginal<typeof import('@renderer/lib/ipc')>();
  const testRpc = new Proxy({}, { get: (_, key) => (key === 'agents' ? agents : namespace) });
  return {
    ...original,
    rpc: testRpc,
    rpcOn: () => testRpc,
    // 「关闭并切换」的进度由测试按主进程的样子推。
    onMachineEvent: ((machine, event, cb) => {
      if (event.name !== 'subscriptions:switch-progress') return original.onMachineEvent(machine, event, cb);
      const listener = cb as (data: { providerId: string; closed: number; total: number }) => void;
      control.progressListeners.add(listener);
      return () => control.progressListeners.delete(listener);
    }) as typeof original.onMachineEvent,
  };
});

// 套餐读数可以被按住不答(看「刷新」读着的时候画成什么样)。
const control = vi.hoisted(() => ({
  hold: null as Promise<void> | null,
  membershipError: false,
  held: 0,
  created: null as Record<string, unknown> | null,
  removed: [] as string[],
  renamed: [] as { providerId: string; connectionId: string; name: string }[],
  origin: undefined as 'environment' | 'config-file' | undefined,
  forcedUsage: [] as string[],
  selected: '',
  connections: [] as HarnessConnection[],
  codex: false,
  agentHomes: [] as AgentHomeScan[],
  others: false,
  signedOut: false,
  expired: false,
  rejectSelect: false,
  selectMessage: 'Switch failed',
  selectBusy: null as { providerId: string; count: number } | null,
  stopBusySessions: [] as boolean[],
  oldHost: false,
  closeHold: null as Promise<void> | null,
  progressListeners: new Set<(data: { providerId: string; closed: number; total: number }) => void>(),
  usageByConnection: {} as Record<string, { windowMinutes: number; usedPercent: number }[]>,
  connectionsError: false,
  keyed: false,
  /** 这几家各有各的连接(缺席的家共用 `connections`,与之前一样)。 */
  connectionsByProvider: {} as Record<string, HarnessConnection[]>,
}));

function connectionsOf(providerId: string | undefined): HarnessConnection[] {
  return (providerId && control.connectionsByProvider[providerId]) || control.connections;
}

vi.mock('@/store/auth', () => ({ useAuth: () => ({ user: { id: 'subscription-test' } }) }));
vi.mock('@/lib/billing', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/billing')>()),
  formatCredits: (value: number) => new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(value),
  quotaWindowViews: () => ({ period: { hours: 744, limit: 4, remaining: 3.2 - control.held, freesAt: new Date('2026-11-01T00:00:00Z') } }),
  useSpendingPower: () => ({ membership: control.membershipError ? null : { tier: 'free', expiresAt: null }, power: { spendable: 8.2 - control.held, periodCredits: 3.2, walletCredits: 5, held: control.held },
    balanceError: control.membershipError ? 'offline' : null, windowsError: null, activityRevision: 0,
    windows: { plan_id: 'free', period_credits: 4, period_used: 0.8, period_started_at: '2026-10-01T00:00:00Z', period_ends_at: '2026-11-01T00:00:00Z', outstanding_credits: control.held, credits_per_usd: 1 } }),
  refreshSpendingPower: () => {},
}));
vi.mock('@renderer/lib/stores/use-agent-auth-status', () => ({
  useAgentAuthStatus: () => ({ auth: { status: control.signedOut ? { kind: 'unauthenticated', ...(control.expired ? { reason: 'expired' } : {}) } : { kind: 'authenticated', account: 'me@example.test' }, login: null }, refresh: async () => {} }),
  useAgentAuthStatuses: () => ({ auths: [], refresh: async () => {} }),
  useExpiredAgentIds: () => new Set(),
}));

vi.mock('@renderer/lib/agent-config/runtime-client', () => ({
  getAgentConfigRuntimeClient: async () => ({
    scanAgentHomes: async ({ providerIds }: { providerIds?: string[] }) => ({
      success: true, data: control.agentHomes.filter((home) => !providerIds || providerIds.includes(home.providerId)),
    }),
    listCustomModels: async () => ({ success: true, data: [] }),
    listConnections: async ({ providerId }: { providerId?: string } = {}) => control.connectionsError
      ? { success: false, error: { message: 'Connections offline' } }
      : { success: true, data: [...connectionsOf(providerId)] },
    refreshAuthStatus: async () => ({ success: true, data: control.signedOut ? { kind: 'unauthenticated', ...(control.expired ? { reason: 'expired' } : {}) } : { kind: 'authenticated', account: 'me@example.test', ...(control.origin ? { credentialSource: control.origin } : {}) } }),
    createConnection: async (input: Record<string, unknown>) => {
      control.created = input;
      const connection: HarnessConnection = input.kind === 'account'
        ? { id: 'account-1', kind: 'account', name: 'Claude 1', current: false }
        : { id: 'api-1', kind: 'account', name: 'Saved API',
          ...(Array.isArray(input.models) ? { models: input.models as string[] } : {}), current: false };
      connectionsOf(input.providerId as string).push(connection);
      return { success: true, data: connection };
    },
    renameConnection: async (input: { providerId: string; connectionId: string; name: string }) => {
      control.renamed.push(input);
      const list = connectionsOf(input.providerId);
      const target = list.find(connection => connection.id === input.connectionId)!;
      target.name = input.name;
      return { success: true, data: { ...target } };
    },
    // 宿主读这个地址的模型清单(#2507 第 6 轮)。
    listConnectionModels: async () => ({ success: true, data: { kind: 'listed', models: ['qwen3-coder-plus', 'qwen3-max'] } }),
    removeConnection: async ({ providerId, connectionId }: { providerId?: string; connectionId: string }) => {
      control.removed.push(connectionId);
      const list = connectionsOf(providerId);
      list.splice(list.findIndex(c => c.id === connectionId), 1);
      return { success: true };
    },
    selectConnection: async ({ providerId, connectionId, stopBusySessions }: { providerId?: string; connectionId: string; stopBusySessions?: boolean }) => {
      control.stopBusySessions.push(stopBusySessions === true);
      if (stopBusySessions && control.closeHold) await control.closeHold;
      // 「关闭并切换」= 正在工作的也关掉:宿主不再拒。
      if (control.rejectSelect && !(stopBusySessions && control.selectBusy && !control.oldHost)) {
        return { success: false, error: { type: 'invalid-state', message: control.selectMessage, ...(control.selectBusy ? { sessionsBusy: control.selectBusy } : {}) } };
      }
      control.selected = connectionId;
      if (providerId && control.connectionsByProvider[providerId]) {
        control.connectionsByProvider[providerId] = control.connectionsByProvider[providerId].map(c => ({ ...c, current: c.id === connectionId }));
      } else {
        control.connections = control.connections.map(c => ({ ...c, current: c.id === connectionId }));
      }
      return { success: true };
    },
    readSubscription: async () => {
      if (control.hold) await control.hold;
      return { success: true, data: control.signedOut ? { payer: 'not-signed-in' } : { payer: 'subscription', plan: 'Claude Max 20x' } };
    },
    readSubscriptionUsage: async ({ connectionId, force }: { connectionId?: string; force?: boolean }) => {
      if (force && connectionId) control.forcedUsage.push(connectionId);
      return {
      success: true,
      data: {
        kind: 'windows',
        onDemand: true,
        readAt: Date.now(),
        windows: connectionId && control.usageByConnection[connectionId] ? control.usageByConnection[connectionId] : [
          { windowMinutes: 300, usedPercent: 18, resetsAt: Date.now() + 3_600_000 },
          { windowMinutes: 10_080, group: 'Fable', usedPercent: 92 },
        ],
      },
    }; },
  }),
}));

let root: Root;
let host: HTMLDivElement;
let layer: HTMLDivElement;
const thrown: unknown[] = [];
// 只收真抛出来的东西。浏览器的「ResizeObserver loop completed with undelivered notifications」也走 window error,
// 但它不是异常(error 为 null):Base UI 的菜单内容长过它这一侧的 --available-height 时，先被压到那个高度、再 flip 到另一侧，
// 两步落在同一轮 ResizeObserver 回调里(设计如此，见 @base-ui/react useAnchorPositioning 的 flip padding)。
// 菜单正好贴着视口边时(Qwen 那格：下方 220px、内容 221px)这条提示时有时无，算进来就时红时绿。
const onError = (event: ErrorEvent) => { if (event.error !== null) thrown.push(event.error); };

/** 那一行「连接」那一块里的几样(与资源库详情同一块,#2507)。 */
const addButton = (provider: string) => host.querySelector<HTMLButtonElement>(`[data-testid="subscription-add-${provider}"]`);
const switchTrigger = (provider: string) => host.querySelector<HTMLElement>(`[data-testid="subscription-switch-${provider}"]`);
const noConnection = (provider: string) => host.querySelector(`[data-testid="subscription-no-connection-${provider}"]`);
/** 表单顶上的方式分段;只有一种方式时不画(空)。 */
const methodButtons = () => [...host.querySelectorAll('.subscription-connection-form [role="tab"]')].map(b => b.textContent);
async function openSwitch(provider: string) {
  await until('the current connection can be switched', () => switchTrigger(provider)?.hasAttribute('data-disabled') === false);
  await userEvent.click(page.getByTestId(`subscription-switch-${provider}`));
}

// Account-scoped replicas read only for a live account.
followRendererSession('SIGNED_IN', 'subscription-test');

beforeEach(() => {
  queryClient.clear();
  control.hold = null;
  control.membershipError = false;
  control.held = 0;
  control.created = null;
  control.removed = [];
  control.renamed = [];
  control.forcedUsage = [];
  control.origin = undefined;
  control.selected = '';
  control.codex = false;
  control.agentHomes = [];
  control.others = false;
  control.signedOut = false;
  control.expired = false;
  control.rejectSelect = false;
  control.selectMessage = 'Switch failed';
  control.selectBusy = null;
  control.stopBusySessions = [];
  control.oldHost = false;
  control.closeHold = null;
  control.progressListeners.clear();
  control.usageByConnection = {};
  control.connectionsError = false;
  control.keyed = false;
  control.connectionsByProvider = {};
  control.connections = [{ id: 'native', kind: 'native', name: '', current: true }];
  host = document.createElement('div');
  layer = document.createElement('div');
  for (const el of [host, layer]) {
    el.className = 'gugu-skin emlight';
    document.body.append(el);
  }
  root = createRoot(host, { onUncaughtError: (error) => thrown.push(error) });
  thrown.length = 0;
  window.addEventListener('error', onError);
});

afterEach(async () => {
  modalStore.closeModal();
  setLocalePreference('en-US');
  window.removeEventListener('error', onError);
  root.unmount();
  host.remove();
  layer.remove();
});


/** The Library still uses these connection controls after subscriptions move to Models. */
function ConnectionDetailsFixture() {
  useLayoutEffect(() => {
    modalStore.setPortalContainer(layer);
    return () => modalStore.setPortalContainer(null);
  }, []);
  return <QueryClientProvider client={queryClient}><SessionLocalizationProvider>
    <UiPortalContainerProvider value={layer}><ConnectionDetailsList /></UiPortalContainerProvider>
  </SessionLocalizationProvider></QueryClientProvider>;
}
function ConnectionDetailsList() {
  const reading = useManagementAgents();
  const data = reading.state === 'value' ? reading.value : undefined;
  return <>{data?.filter(agent => agent.id !== 'pi').map(agent => <div key={agent.id} data-testid={`subscription-row-${agent.id}`}>
    {agentOffersConnections(agent) && <AgentConnectionDetails agent={agent} machine={null} embedded />}
  </div>)}</>;
}

it.each(['claude', 'codex'])('an expired current %s account offers "Sign in again" on the row itself, without opening any menu', async provider => {
  control.codex = true;
  control.signedOut = true;
  control.expired = true;
  control.connections = [{ id: 'expired-account', kind: 'account', name: 'Saved account', current: true }];
  root.render(<ConnectionDetailsFixture />);
  await until('the sign-in action is on the row', () => !!host.querySelector(`[data-testid="subscription-sign-in-${provider}"]`));
  const button = host.querySelector(`[data-testid="subscription-sign-in-${provider}"]`) as HTMLButtonElement;
  expect(button.textContent).toBe('Sign in again');
  button.click();
  expect(modalStore.activeModalId).toBe('agentSignInModal');
  expect(modalStore.activeModalArgs).toMatchObject({ providerId: provider, connectionId: 'expired-account' });
  expect(thrown).toEqual([]);
});

// #3394: an auth file can still read as signed in after revocation, so re-login must stay reachable.
it('a signed-in account offers re-login on the row for that same connection', async () => {
  control.connections = [{ id: 'account', kind: 'account', name: 'Saved account', current: true }];
  root.render(<ConnectionDetailsFixture />);
  await until('the signed-in identity is read', () => host.querySelector('[data-testid="connection-status-claude"]')?.textContent?.includes('me@example.test') === true);
  await until('the signed-in row offers re-login', () => host.querySelector('[data-testid="subscription-sign-in-claude"]')?.textContent === 'Sign in again');
  await userEvent.click(page.getByTestId('subscription-sign-in-claude'));
  expect(modalStore.activeModalId).toBe('agentSignInModal');
  expect(modalStore.activeModalArgs).toMatchObject({ providerId: 'claude', connectionId: 'account' });
  expect(control.created).toBeNull();
  expect(control.removed).toEqual([]);
  expect(control.selected).toBe('');
  expect(thrown).toEqual([]);
});

it.each(['claude', 'codex'])('an expired saved %s account preserves its sign-in menu', async provider => {
  control.codex = true;
  control.signedOut = true;
  control.expired = true;
  control.connections = [{ id: 'expired-account', kind: 'account', name: 'Saved account', current: true }];
  root.render(<ConnectionDetailsFixture />);
  await openSwitch(provider);
  await until('the connection list opens', () => !!layer.querySelector('[data-testid="connection-expired-account"]'));
  expect(host.querySelector('.subscription-connection-form')).toBeNull();
  await userEvent.click(page.getByRole('button', { name: 'Options for Saved account', exact: true }));
  // #3394: an expired saved account says "Sign in again", rather than first-time "Sign in".
  const signIn = page.getByRole('menuitem', { name: 'Sign in again', exact: true });
  await expect.element(signIn).toBeVisible();
  await untilStable('the saved account sign-in menu settles', () => {
    const { x, y, width, height } = signIn.element().getBoundingClientRect();
    return { x, y, width, height };
  });
  await userEvent.click(signIn);
  expect(modalStore.activeModalId).toBe('agentSignInModal');
  expect(modalStore.activeModalArgs).toMatchObject({ providerId: provider, connectionId: 'expired-account' });
  expect(control.created).toBeNull();
  expect(control.removed).toEqual([]);
  expect(control.selected).toBe('');
  expect(thrown).toEqual([]);
});

// owner 2026-11-12:「我没有配置啊……你为什么要有一个占位呢」—— 没登上的「现有 CLI 配置」不列;这一行写「未登录」,
// 当前连接写「没有」,只给「添加连接」,点了就地是表单(与资源库详情同一块)。
it.each(['claude', 'codex'])('an unsigned native %s connection is not listed; Add connection opens the form in place', async provider => {
  control.codex = true;
  control.signedOut = true;
  root.render(<ConnectionDetailsFixture />);
  await until('the unconfigured harness has an add action', () => !!addButton(provider) && !!noConnection(provider));
  const row = host.querySelector(`[data-testid="subscription-row-${provider}"]`)!;
  expect(noConnection(provider)?.textContent).toBe('None');
  expect(switchTrigger(provider)).toBeNull();
  await until('the row says it is not signed in', () => row.querySelector(`[data-testid="connection-status-${provider}"]`)?.textContent === 'Not signed in');
  expect(row.textContent).not.toContain('Existing CLI configuration');
  expect(host.textContent).not.toContain('Library');
  addButton(provider)!.click();
  await until('the connection form opens in Settings', () => !!row.querySelector('.subscription-connection-form'));
  expect(methodButtons()).toEqual([]);
  expect(row.querySelector('form button[type="submit"]')?.textContent).toBe('Add and sign in');
  expect(row.querySelector('form input[type="password"], form input[type="url"]')).toBeNull();
  expect(row.querySelector('form')?.closest('[aria-hidden="true"], [inert]')).toBeNull();
  expect(layer.querySelector('[role="menu"]')).toBeNull();
  expect(control.created).toBeNull();
  expect(thrown).toEqual([]);
});

// owner 2026-11-12 选 A:「添加连接 → 账号」没登成功(失败或取消)就把这条新连接拿掉;窗口关时已经登上的留着。
it.each([
  ['still signed out', true, ['account-1']],
  ['already signed in', false, []],
])('a new account connection whose sign-in window closes %s is removed only when it never signed in', async (_label, signedOut, removed) => {
  control.signedOut = true;
  root.render(<ConnectionDetailsFixture />);
  await until('the Claude row has its add action', () => !!addButton('claude'));
  addButton('claude')!.click();
  await until('the account form opens', () => !!host.querySelector('.subscription-connection-form button[type="submit"]'));
  (host.querySelector('.subscription-connection-form button[type="submit"]') as HTMLButtonElement).click();
  await until('the sign-in window opens for the new connection', () => modalStore.activeModalId === 'agentSignInModal');
  expect(control.created).toMatchObject({ providerId: 'claude', kind: 'account' });
  expect(modalStore.activeModalArgs).toMatchObject({ providerId: 'claude', connectionId: 'account-1' });
  control.signedOut = signedOut;
  (modalStore.activeModalArgs as { onClose: () => void }).onClose();
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(control.removed).toEqual(removed);
  expect(thrown).toEqual([]);
});

// #2507 owner 2026-11-12:「订阅里面说去资源库智能体里登录，但我去看现在根本没有登录选项……本来这里应该点击直接跳转的」。
// 之后:「所以订阅页那颗单独的『登录』也收进『添加连接』,统一一个入口」——「账号」= 登它 CLI 自己那一份,同一个登录窗口。
it('another agent that is not signed in signs in through Add connection → Account, opening the same sign-in window; one without any way in gets nothing', async () => {
  control.others = true;
  control.signedOut = true;
  root.render(<ConnectionDetailsFixture />);
  await until('the Kimi row offers Add connection', () => !!addButton('kimi') && !!noConnection('kimi'));
  // 一个入口:❌ 行上另一颗「登录」。
  expect(host.querySelector('[data-testid="subscription-sign-in-kimi"]')).toBeNull();
  expect(host.textContent).not.toContain('Library');
  addButton('kimi')!.click();
  await until('the Kimi form opens', () => !!host.querySelector('[data-testid="subscription-row-kimi"] .subscription-connection-form'));
  // 只有账号一种方式:不画分段,直接是登录那一种。
  expect(methodButtons()).toEqual([]);
  const submit = host.querySelector<HTMLButtonElement>('.subscription-connection-form button[type="submit"]')!;
  expect(submit.textContent).toBe('Sign in');
  submit.click();
  expect(modalStore.activeModalId).toBe('agentSignInModal');
  expect(modalStore.activeModalArgs).toMatchObject({ providerId: 'kimi', steps: [{ methodId: 'kimi-login', transport: 'terminal' }] });
  expect(control.created).toBeNull();
  expect(thrown).toEqual([]);
});

// Claude and Codex open the managed account form directly when they have no connections.
it.each(['claude', 'codex'])('an empty %s connection list opens Add connection directly', async provider => {
  control.codex = true;
  control.signedOut = true;
  control.connections = [];
  root.render(<ConnectionDetailsFixture />);
  await until('the empty connection list has an add action', () => !!addButton(provider) && !!noConnection(provider));
  expect(switchTrigger(provider)).toBeNull();
  addButton(provider)!.click();
  await until('the existing connection form opens directly', () => !!host.querySelector('.subscription-connection-form'));
  expect(layer.querySelector('[role="menu"], [role="listbox"]')).toBeNull();
  expect(control.created).toBeNull();
  expect(thrown).toEqual([]);
});

it('shows managed local configuration with no sign-in or connection menu', async () => {
  control.connections = [];
  control.signedOut = true;
  control.agentHomes = [{ providerId: 'claude', name: 'Claude Code', userRoot: '/fixture/.claude', sourceReadable: true,
    importedAt: '2026-11-01T00:00:00.000Z', needsImport: false, sourceUpdated: true, migration: false,
    groups: [], issues: [], mcpSecrets: [], projectMcpCount: 0 }];
  root.render(<ConnectionDetailsFixture />);
  await until('local configuration is available in the subscription row', () => !!host.querySelector('[data-testid="subscription-row-claude"] [data-testid="agent-home-reimport-claude"]'));
  expect(switchTrigger('claude')).toBeNull();
  expect(layer.querySelector('[role="listbox"]')).toBeNull();
  expect(thrown).toEqual([]);
});






it('subscriptions contains only Gugu membership and does not turn membership errors into Free', async () => {
  control.membershipError = true;
  root.render(<SessionSettingsContent section="subscriptions" portalContainer={layer} />);
  await until('membership error is visible', () => host.querySelector('[data-testid="subscription-row-gugu"]')?.textContent?.includes('offline') === true);
  const gugu = host.querySelector('[data-testid="subscription-row-gugu"]')!;
  expect(gugu.querySelector('.subscription-plan-badge')).toBeNull();
  expect(host.querySelector('[data-testid="subscription-row-claude"]')).toBeNull();
  expect(host.querySelector('[data-testid="subscription-row-codex"]')).toBeNull();
  expect(host.querySelector('[data-testid="subscription-add-claude"]')).toBeNull();
  expect(thrown).toEqual([]);
});

it.each([390, 720, 1120])('Gugu credits are settings rows in a %s px container: labels left, figures in one right-aligned column', async width => {
  host.style.cssText = `width: ${width}px; container: gg-settings / inline-size`;
  root.render(<GuguSubscriptionRow />);
  await until('the Gugu balances render', () => host.querySelector('[data-testid="subscription-credits-balance"]')?.textContent?.includes('8.2') ?? false);
  const row = host.querySelector<HTMLElement>('[data-testid="subscription-row-gugu"]')!;
  const figures = ['subscription-credits-balance', 'subscription-period-credits', 'subscription-wallet-credits']
    .map(id => row.querySelector<HTMLElement>(`[data-testid="${id}"]`)!.closest<HTMLElement>('.gg-settings-row')!);
  await untilStable('the credit rows are measured', () => figures.map(f => f.getBoundingClientRect().top).join(','));
  // Each figure is its row's trailing value, and the three share one right edge.
  const rights = figures.map(f => f.querySelector<HTMLElement>('.gg-settings-row-control')!.getBoundingClientRect().right);
  expect(Math.max(...rights) - Math.min(...rights)).toBeLessThanOrEqual(1);
  for (const f of figures) {
    expect(f.querySelector('.gg-settings-row-title')!.getBoundingClientRect().left).toBeLessThan(f.querySelector('.gg-settings-row-control')!.getBoundingClientRect().left);
  }
  // Same body size as every other settings value: no oversized total.
  const sizes = figures.map(f => getComputedStyle(f.querySelector('.subscription-figure')!).fontSize);
  expect(new Set(sizes).size).toBe(1);
  const recharge = row.querySelector<HTMLElement>('[data-testid="membership-open-web"]')!;
  expect(recharge.getAttribute('href')).toBe('https://gugu.nextmind.space/dashboard/#topup');
  expect(row.querySelector('a')?.getAttribute('href')).toBe('https://gugu.nextmind.space/dashboard/');
  expect(recharge.getBoundingClientRect().width).toBeLessThan(host.clientWidth * 0.7);
  expect(row.querySelector('[data-testid="subscription-billing-copy"]')).toBeNull();
  expect(host.scrollWidth).toBeLessThanOrEqual(host.clientWidth);
});

it('explains reserved credits when the available total differs from the two balances', async () => {
  control.held = 1;
  root.render(<SessionSettingsContent section="subscriptions" portalContainer={layer} />);
  await until('the reservation is shown', () => /预留|reserved/.test(host.querySelector('[data-testid="subscription-row-gugu"]')?.textContent ?? ''));
  expect(host.querySelector('[data-testid="subscription-row-gugu"]')?.textContent).toContain('7.2');
});



it('a failed connection read shows its failure instead of staying in the loading state', async () => {
  control.connectionsError = true;
  root.render(<ConnectionDetailsFixture />);
  await until('the row shows the connection error', () => host.querySelector('[data-testid="subscription-row-claude"]')?.textContent?.includes('Connections offline') === true);
  expect(host.querySelector('[data-testid="subscription-row-claude"]')?.textContent).not.toMatch(/正在读|Reading[.…]|Checking/);
});

it('a failed dropdown switch keeps the previous current connection', async () => {
  control.rejectSelect = true;
  control.connections.push({ id: 'saved-api', kind: 'account', name: 'Saved API', current: false });
  root.render(<ConnectionDetailsFixture />);
  await until('the switch is ready', () => host.querySelector('[data-testid="subscription-switch-claude"]') !== null);
  await openSwitch('claude');
  await until('the API option can be used', () => layer.querySelector('[data-testid="connection-use-saved-api"]')?.hasAttribute('data-disabled'), disabled => disabled === false);
  expect(layer.querySelector('[role="dialog"]')).toBeNull();
  (layer.querySelector('[data-testid="connection-use-saved-api"]') as HTMLElement).click();
  await until('the switch error is displayed', () => host.textContent?.includes('Switch failed') === true);
  expect(control.connections.find(c => c.current)?.id).toBe('native');
  expect(control.selected).toBe('');
  expect(thrown).toEqual([]);
});


// 2026-10-23 真机:6 个 Codex 会话在干活时点「切换连接」,被拒的那句长提示进了最右那一列(宽度 auto),
// 按最大宽度把列撑开,中间的账号列被挤到几乎没有宽度 —— 邮箱一个字一行,提示压在标题上。
// 判据是真排版:提示出现前后状态那一行与「当前连接」那一格一样宽;提示整句落在这一行之内、在标题与状态之下。



// 2026-10-23 owner:「提示更温柔一点,不要飘红,language 也变一下」。因有会话正在工作而没切,不是出错:
// 主进程把「哪一家、几个」随错误带来,界面按自己的语言用安静的字色说;不认得这个字段的旧主进程走上面那条(红、原文)。
it.each([
  ['en-US' as const, 6, /^6 Codex sessions are still working\. Switching now interrupts them/],
  ['en-US' as const, 1, /^1 Codex session is still working\. Switching now interrupts it/],
  ['zh-CN' as const, 6, /^还有 6 个 Codex 会话正在工作，现在切换会中断它们/],
])('a refusal because sessions are working is a calm note in the UI language (%s, %i)', async (language, count, expected) => {
  setLocalePreference(language);
  control.codex = true;
  control.rejectSelect = true;
  control.selectBusy = { providerId: 'codex', count };
  control.selectMessage = `${count} Codex sessions are still working. Switch the subscription after they finish; switching restarts every running Codex session.`;
  control.connections.push({ id: 'saved-api', kind: 'account', name: 'Saved API', current: false });
  host.style.width = '720px';
  root.render(<ConnectionDetailsFixture />);
  await until('the Codex switch is ready', () => host.querySelector('[data-testid="subscription-switch-codex"]') !== null);
  const row = host.querySelector('[data-testid="subscription-row-codex"]') as HTMLElement;
  await openSwitch('codex');
  await until('the saved API option can be used', () => layer.querySelector('[data-testid="connection-use-saved-api"]')?.hasAttribute('data-disabled'), disabled => disabled === false);
  (layer.querySelector('[data-testid="connection-use-saved-api"]') as HTMLElement).click();
  await until('the note is displayed', () => row.querySelector('.subscription-note') !== null);

  const note = row.querySelector('.subscription-note') as HTMLElement;
  expect(note.textContent).toMatch(expected);
  expect(row.textContent).not.toContain('Switch the subscription after they finish');
  expect(note.getAttribute('role')).toBe('status');
  expect(row.querySelector('[role="alert"]')).toBeNull();
  // 不飘红:字色与真错误那条不同。
  const reference = document.createElement('p');
  reference.className = 'subscription-error';
  row.append(reference);
  expect(getComputedStyle(note).color).not.toBe(getComputedStyle(reference).color);
  reference.remove();
  expect(control.connections.find(c => c.current)?.id).toBe('native');

  // 提示的字句是渲染时算的,界面语言一换它跟着换;下一次切成功了,行里不再留着旧的「还在忙」。
  const other = language === 'zh-CN' ? 'en-US' : 'zh-CN';
  const before = note.textContent;
  setLocalePreference(other);
  await until('the note follows the language', () => row.querySelector('.subscription-note')?.textContent !== before);
  expect(row.querySelector('.subscription-note')?.textContent).toMatch(other === 'zh-CN' ? /^还有 \d+ 个 Codex 会话/ : /^\d+ Codex sessions? (is|are) still working/);
  control.rejectSelect = false;
  if (!layer.querySelector('[data-testid="connection-use-saved-api"]')) await openSwitch('codex');
  await until('the saved API option can be used again', () => layer.querySelector('[data-testid="connection-use-saved-api"]')?.hasAttribute('data-disabled'), disabled => disabled === false);
  (layer.querySelector('[data-testid="connection-use-saved-api"]') as HTMLElement).click();
  await until('the note is gone once a switch goes through', () => row.querySelector('.subscription-note') === null);
  expect(control.selected).toBe('saved-api');
  expect(thrown).toEqual([]);
});

// 10-30 owner:「要求会话停了才能切，又不给一个百分百成功的一键暂停，我想切额度都切不了」。
// 被拒之后一键关掉正在工作的会话、接着切到刚才选的那个号;关不关由人定,❌ 让人自己去找会话一个个停。
it('a refusal offers one click that closes the working sessions and switches to the chosen connection', async () => {
  setLocalePreference('zh-CN');
  control.codex = true;
  control.rejectSelect = true;
  control.selectBusy = { providerId: 'codex', count: 9 };
  control.connections.push({ id: 'saved-api', kind: 'account', name: 'Saved API', current: false });
  host.style.width = '720px';
  root.render(<ConnectionDetailsFixture />);
  await until('the Codex switch is ready', () => host.querySelector('[data-testid="subscription-switch-codex"]') !== null);
  const row = host.querySelector('[data-testid="subscription-row-codex"]') as HTMLElement;
  await openSwitch('codex');
  await until('the saved API option can be used', () => layer.querySelector('[data-testid="connection-use-saved-api"]')?.hasAttribute('data-disabled'), disabled => disabled === false);
  (layer.querySelector('[data-testid="connection-use-saved-api"]') as HTMLElement).click();
  await until('the refusal offers to close and switch', () => row.querySelector('[data-testid="subscription-close-and-switch"]') !== null);
  const closeAndSwitch = row.querySelector('[data-testid="subscription-close-and-switch"]') as HTMLButtonElement;
  expect(closeAndSwitch.textContent).toBe('关闭并切换');
  expect(control.stopBusySessions).toEqual([false]);
  expect(control.connections.find(c => c.current)?.id).toBe('native');

  // 关的这段时间(等进程退出)原地说正在做什么,按钮收起，不留一片空白。
  let release!: () => void;
  control.closeHold = new Promise<void>((resolve) => (release = resolve));
  closeAndSwitch.click();
  await until('the row says it is closing', () => row.querySelector('.subscription-switch-progress')?.textContent?.startsWith('正在关闭 Codex 会话，完成后切换') === true);
  expect(row.querySelector('[data-testid="subscription-close-and-switch"]')).toBeNull();
  expect(row.querySelector('[role="alert"]')).toBeNull();
  // 进度条读主进程报的真数:关完几个 / 一共几个;还没报时是空条、不写数。
  const bar = () => row.querySelector('[data-testid="subscription-close-progress"]') as HTMLElement;
  expect(bar().getAttribute('aria-valuenow')).toBe('0');
  expect(row.querySelector('[data-testid="subscription-close-progress-count"]')).toBeNull();
  await until('the progress listener is attached', () => control.progressListeners.size > 0);
  for (const listener of control.progressListeners) listener({ providerId: 'claude', closed: 1, total: 1 });
  for (const listener of control.progressListeners) listener({ providerId: 'codex', closed: 3, total: 9 });
  await until('the bar shows 3 of 9', () => row.querySelector('[data-testid="subscription-close-progress-count"]')?.textContent === '3 / 9');
  expect(bar().getAttribute('aria-valuenow')).toBe('3');
  expect(bar().getAttribute('aria-valuemax')).toBe('9');
  expect(parseFloat((bar().querySelector('i') as HTMLElement).style.width)).toBeCloseTo((3 / 9) * 100, 2);
  release();
  await until('the switch goes through', () => control.selected === 'saved-api');
  expect(control.stopBusySessions).toEqual([false, true]);
  await until('the refusal is gone', () => row.querySelector('.subscription-note') === null && row.querySelector('.subscription-switch-progress') === null && row.querySelector('[data-testid="subscription-close-and-switch"]') === null);
  expect(row.querySelector('[role="alert"]')).toBeNull();
  expect(thrown).toEqual([]);
});

// 远端那台的咕咕还是旧版:它不认「关掉」这一格，带上了照样拒。说清楚去更新,❌ 再摆一个按了没反应的按钮。
it('a host too old to close working sessions says to update it instead of offering the button again', async () => {
  setLocalePreference('zh-CN');
  control.codex = true;
  control.rejectSelect = true;
  control.oldHost = true;
  control.selectBusy = { providerId: 'codex', count: 2 };
  control.connections.push({ id: 'saved-api', kind: 'account', name: 'Saved API', current: false });
  root.render(<ConnectionDetailsFixture />);
  await until('the Codex switch is ready', () => host.querySelector('[data-testid="subscription-switch-codex"]') !== null);
  const row = host.querySelector('[data-testid="subscription-row-codex"]') as HTMLElement;
  await openSwitch('codex');
  await until('the saved API option can be used', () => layer.querySelector('[data-testid="connection-use-saved-api"]')?.hasAttribute('data-disabled'), disabled => disabled === false);
  (layer.querySelector('[data-testid="connection-use-saved-api"]') as HTMLElement).click();
  await until('the refusal offers to close and switch', () => row.querySelector('[data-testid="subscription-close-and-switch"]') !== null);
  (row.querySelector('[data-testid="subscription-close-and-switch"]') as HTMLButtonElement).click();
  await until('the outdated host is named', () => row.querySelector('[role="alert"]') !== null);
  expect(row.querySelector('[role="alert"]')?.textContent).toBe('该设备上的咕咕版本过旧，无法关闭正在工作的会话。请更新后再切换。');
  expect(row.querySelector('[data-testid="subscription-close-and-switch"]')).toBeNull();
  expect(control.stopBusySessions).toEqual([false, true]);
  expect(control.connections.find(c => c.current)?.id).toBe('native');
});

it('a real failure is red and offers no close-and-switch', async () => {
  control.codex = true;
  control.rejectSelect = true;
  control.selectMessage = 'Sign in before using this connection';
  control.connections.push({ id: 'saved-api', kind: 'account', name: 'Saved API', current: false });
  root.render(<ConnectionDetailsFixture />);
  await until('the Codex switch is ready', () => host.querySelector('[data-testid="subscription-switch-codex"]') !== null);
  const row = host.querySelector('[data-testid="subscription-row-codex"]') as HTMLElement;
  await openSwitch('codex');
  await until('the saved API option can be used', () => layer.querySelector('[data-testid="connection-use-saved-api"]')?.hasAttribute('data-disabled'), disabled => disabled === false);
  (layer.querySelector('[data-testid="connection-use-saved-api"]') as HTMLElement).click();
  await until('the failure is displayed', () => row.querySelector('[role="alert"]') !== null);
  expect(row.querySelector('[data-testid="subscription-close-and-switch"]')).toBeNull();
});

// 10-30 owner:「现在只有换号了才知道另一个号的额度，不换号我也想知道其他号的额度」。
it('the switch menu shows how much each account has left without switching to it', async () => {
  setLocalePreference('zh-CN');
  control.codex = true;
  control.connections = [
    { id: 'native', kind: 'native', name: '', current: true },
    { id: 'second', kind: 'account', name: 'Second account', current: false },
  ];
  control.usageByConnection = {
    native: [{ windowMinutes: 10_080, usedPercent: 100 }],
    second: [{ windowMinutes: 300, usedPercent: 10 }, { windowMinutes: 10_080, usedPercent: 35 }],
  };
  host.style.width = '720px';
  root.render(<ConnectionDetailsFixture />);
  // The switch is there (disabled) while the connections are read; press it once it is usable, as a person would.
  await openSwitch('codex');
  await until('the other account shows its quota', () => layer.querySelector('[data-testid="connection-quota-second"]') !== null);
  const second = layer.querySelector('[data-testid="connection-quota-second"]') as HTMLElement;
  expect(second.textContent).toBe('5 小时剩余 90%，每周剩余 65%');
  expect(second.hasAttribute('data-warning')).toBe(false);
  await until('the current account shows its quota', () => layer.querySelector('[data-testid="connection-quota-native"]') !== null);
  const current = layer.querySelector('[data-testid="connection-quota-native"]') as HTMLElement;
  expect(current.textContent).toBe('每周剩余 0%');
  expect(current.hasAttribute('data-warning')).toBe(true);
  expect(control.selected).toBe('');
  expect(thrown).toEqual([]);
});

it.each([
  { provider: 'claude', kind: 'native' as const }, { provider: 'codex', kind: 'native' as const },
  { provider: 'claude', kind: 'account' as const }, { provider: 'codex', kind: 'account' as const },
])('an authenticated $provider $kind connection can re-login without creating or selecting an account', async ({ provider, kind }) => {
  control.codex = true;
  control.connections = [{ id: 'existing', kind, name: 'Existing account', current: true }];
  root.render(<ConnectionDetailsFixture />);
  await openSwitch(provider);
  await until('the account has been read', () => layer.querySelector('[data-testid="connection-existing"]')?.textContent?.includes('me@example.test') === true);
  const existing = layer.querySelector('[data-testid="connection-existing"]')!;
  // #3394: both kinds keep re-login visible while authenticated; native still cannot be removed.
  expect(host.querySelector(`[data-testid="subscription-sign-in-${provider}"]`)?.textContent).toBe('Sign in again');
  const options = existing.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]');
  expect(options).not.toBeNull();
  await userEvent.click(options!);
  await until('its options open', () => layer.querySelectorAll('[role="menuitem"]').length > 0);
  expect([...layer.querySelectorAll('[role="menuitem"]')].map(item => item.textContent))
    .toEqual(kind === 'native' ? ['Sign in again'] : ['Sign in again', 'Remove']);
  await userEvent.click(page.getByRole('menuitem', { name: 'Sign in again', exact: true }));
  expect(modalStore.activeModalId).toBe('agentSignInModal');
  expect(modalStore.activeModalArgs).toMatchObject({ providerId: provider, connectionId: 'existing' });
  expect(control.created).toBeNull();
  expect(control.removed).toEqual([]);
  expect(control.selected).toBe('');
  expect(addButton(provider)).not.toBeNull();
  expect(thrown).toEqual([]);
});

// owner 2026-11-12:「关键是现在订阅和资源库的 Agent 其实是不统一的，但按理说应该统一才对」——
// 同一家在两处是同一块:状态那一行、当前连接、添加连接,同一份读数、同一组按钮。
const blockRows = (block: Element | null) =>
  [...(block?.querySelectorAll('.gg-settings-row') ?? [])].map(row => row.textContent);

it.each([
  ['claude', false],
  ['claude', true],
  ['mimocode', true],
  ['qwen', true],
])('%s (signed out: %s) keeps the standalone connection controls consistent with the Library', async (provider, signedOut) => {
  control.codex = true;
  control.keyed = true;
  control.signedOut = signedOut;
  control.connectionsByProvider.mimocode = [
    { id: 'native', kind: 'native', name: '', current: true },
    { id: 'mimo-key', kind: 'account', name: 'MiMo key', current: false },
  ];
  control.connectionsByProvider.qwen = [{ id: 'native', kind: 'native', name: '', current: true }];
  const detailHost = document.createElement('div');
  detailHost.className = 'gugu-skin emlight';
  document.body.append(detailHost);
  const detailRoot = createRoot(detailHost);
  root.render(<ConnectionDetailsFixture />);
  detailRoot.render(
    <QueryClientProvider client={queryClient}>
      <SessionLocalizationProvider>
        <AgentDetailModal agentId={provider} onClose={() => {}} />
      </SessionLocalizationProvider>
    </QueryClientProvider>
  );
  try {
    const subscription = () => host.querySelector(`[data-testid="subscription-row-${provider}"] [data-testid="connection-block-${provider}"]`);
    const library = () => document.querySelector(`[role="dialog"] [data-testid="connection-block-${provider}"]`);
    if (provider === 'qwen') {
      await until('Qwen is shown in both surfaces', () =>
        !!host.querySelector('[data-testid="subscription-row-qwen"]') &&
        document.querySelector('[role="dialog"]')?.textContent?.includes('Qwen Code') === true);
      expect(subscription()).toBeNull();
      expect(library()).toBeNull();
      expect(thrown).toEqual([]);
      return;
    }
    const settled = (block: Element | null) =>
      !!block && !block.textContent?.includes('Checking') && !!block.querySelector('[data-testid^="connection-status-"]')?.textContent;
    await until('both blocks have read', () => settled(subscription()) && settled(library()));
    await untilStable('both blocks settle', () => JSON.stringify([blockRows(subscription()), blockRows(library())]));
    expect(subscription()!.querySelector(`[data-testid="connection-status-${provider}"]`)?.textContent)
      .toBe(library()!.querySelector(`[data-testid="connection-status-${provider}"]`)?.textContent);
    expect(blockRows(subscription())).toEqual(blockRows(library()));
    expect(blockRows(subscription()).length).toBeGreaterThanOrEqual(2);
    expect(thrown).toEqual([]);
  } finally {
    detailRoot.unmount();
    detailHost.remove();
  }
});

// 订阅页列的 = 资源库「已安装」那一组,先后也一样(推荐的三家在前，其余按名字);没装的家只在资源库里。



it.each(['claude', 'codex'].flatMap(provider => [{ provider, expired: true }, { provider, expired: false }]))('the model page keeps $provider sign-in reachable with expired=$expired', async ({ provider, expired }) => {
  const capture = expired && provider === 'claude' && import.meta.env.VITE_DESIGN5_CAPTURE === '1';
  if (capture) setLocalePreference('zh-CN');
  control.codex = true;
  control.signedOut = expired;
  control.expired = expired;
  control.connectionsByProvider[provider] = [{ id: 'expired-model-account', kind: 'account', name: capture ? 'Claude Max' : 'Saved plan', current: true }];
  if (capture) {
    await page.viewport(1200, 900);
    document.documentElement.dataset.theme = 'light';
    control.connectionsByProvider.codex = [];
    host.style.cssText = 'width: 940px; padding: 24px; background: var(--sidebar);';
  }
  root.render(<>
    {capture && <p style={{ marginBottom: 20, fontSize: 14 }}>组件测试夹具，非真实账号</p>}
    <div className="gg-pane gg-settings-detail"><div className="gg-settings-page gg-model-page">
      <QueryClientProvider client={queryClient}><SessionLocalizationProvider><UiPortalContainerProvider value={layer}><CustomModelsGroup /></UiPortalContainerProvider></SessionLocalizationProvider></QueryClientProvider>
    </div></div>
  </>);
  await until('the expired account is on the model list', () => !!host.querySelector(`[data-subscription-model="${provider}:expired-model-account"]`));
  const row = host.querySelector(`[data-subscription-model="${provider}:expired-model-account"]`)!;
  if (expired) expect(row.textContent).toContain(capture ? '登录已失效' : 'Sign-in expired');
  else expect(row.textContent).not.toContain('Sign-in expired');
  expect(row.querySelector('[data-testid="model-sign-in-expired-model-account"]')?.textContent).toContain(capture ? '重新登录' : 'Sign in again');
  if (capture) await page.screenshot({ element: host, path: '__screenshots__/design5-models/expired-subscription-fixture.png' });
  await userEvent.click(page.getByTestId('model-sign-in-expired-model-account'));
  expect(modalStore.activeModalId).toBe('agentSignInModal');
  expect(modalStore.activeModalArgs).toMatchObject({ providerId: provider, connectionId: 'expired-model-account' });
  expect(control.created).toBeNull();
  expect(thrown).toEqual([]);
});

function ModelsFixture() {
  return <QueryClientProvider client={queryClient}><SessionLocalizationProvider><UiPortalContainerProvider value={layer}><CustomModelsGroup /></UiPortalContainerProvider></SessionLocalizationProvider></QueryClientProvider>;
}

// 640: the settings card at any common window size (600px rows: sign-in wraps above current/switch and delete).
// 1100: a card wide enough for one line.
it.each([[1100, 'zh-CN'], [640, 'zh-CN'], [640, 'en-US']] as const)('keeps Coding Plan accounts aligned, uncovered and unscrolled in a %ipx card (%s)', async (width, locale) => {
  await setLocalePreference(locale);
  await page.viewport(1280, 1000);
  document.documentElement.dataset.theme = 'light';
  control.codex = true;
  control.connectionsByProvider.codex = [
    { id: 'layout-codex-a', kind: 'account', name: 'fjj', current: false },
    { id: 'layout-codex-b', kind: 'account', name: 'Codex 2', current: true },
  ];
  control.connectionsByProvider.claude = [
    { id: 'layout-claude-a', kind: 'account', name: 'yyh', current: true },
    { id: 'native', kind: 'native', name: '现有 CLI 配置', current: false },
  ];
  control.usageByConnection = {
    'layout-codex-a': [{ windowMinutes: 300, usedPercent: 59 }, { windowMinutes: 10_080, usedPercent: 94 }],
    'layout-codex-b': [{ windowMinutes: 300, usedPercent: 8 }, { windowMinutes: 10_080, usedPercent: 12 }],
    'layout-claude-a': [{ windowMinutes: 300, usedPercent: 0 }, { windowMinutes: 10_080, usedPercent: 23 }],
    native: [{ windowMinutes: 10_080, usedPercent: 5 }],
  };
  host.style.cssText = `width:${width}px;background:var(--sidebar)`;
  try {
    root.render(<>
      <p>组件测试夹具，非真实订阅账号</p>
      <div className="gg-pane gg-settings-detail"><div className="gg-settings-page gg-model-page"><ModelsFixture /></div></div>
    </>);
    await until('all four account rows have their available quota readings', () => host.querySelectorAll('[data-subscription-model] [role="meter"]').length === 7);
    const rows = [...host.querySelectorAll<HTMLElement>('[data-subscription-model]')];
    expect(rows).toHaveLength(4);
    const columns = rows.map(row => {
      const windows = [...row.querySelectorAll<HTMLElement>('.gg-model-quota-window')];
      const state = row.querySelector<HTMLElement>('[data-testid^="model-current-"], [data-testid^="model-switch-"]')!;
      const remove = row.querySelector<HTMLElement>('.gg-model-subscription-remove')!;
      const centre = (element: Element) => { const box = element.getBoundingClientRect(); return box.y + box.height / 2; };
      if (width === 1100) for (const window of windows) expect(Math.abs(centre(window) - centre(state))).toBeLessThan(1);
      const range = document.createRange(); range.selectNodeContents(state);
      const textLines = [...range.getClientRects()].filter(rect => rect.width > 0 && rect.height > 0);
      expect(new Set(textLines.map(rect => Math.round(rect.y))).size).toBe(1);
      expect(getComputedStyle(state).whiteSpace).toBe('nowrap');
      expect(row.scrollWidth).toBeLessThanOrEqual(Math.ceil(row.clientWidth));
      const provider = row.closest<HTMLElement>('.gg-coding-provider')!;
      expect(provider.scrollWidth).toBeLessThanOrEqual(provider.clientWidth);
      // A name too long for its column ends with an ellipsis; the whole name shows on hover.
      const name = row.querySelector<HTMLElement>('.gg-model-name')!;
      expect(name.getAttribute('title')).toBe(name.textContent);
      expect(getComputedStyle(name.querySelector('span')!).textOverflow).toBe('ellipsis');
      // The quota, the sign-in button and current/switch never cover one another: side by side, or sign-in above when narrow.
      const signIn = row.querySelector<HTMLElement>('[data-testid^="model-sign-in-"]')!.getBoundingClientRect();
      const stateBox = state.getBoundingClientRect();
      for (const window of windows) expect(window.getBoundingClientRect().right).toBeLessThanOrEqual(Math.min(signIn.left, stateBox.left));
      // Each window's label, bar and value sit side by side in any language, and the 5-hour window ends before the weekly one.
      for (const window of windows) {
        const [label, track, value] = [...window.children].map(part => part.getBoundingClientRect());
        expect(label.right).toBeLessThanOrEqual(track.left);
        expect(track.right).toBeLessThanOrEqual(value.left);
      }
      if (windows.length === 2) expect(windows[0].getBoundingClientRect().right).toBeLessThanOrEqual(windows[1].getBoundingClientRect().left);
      if (width === 1100) expect(signIn.right).toBeLessThanOrEqual(stateBox.left);
      else expect(signIn.bottom).toBeLessThanOrEqual(stateBox.top);
      return { state: state.getBoundingClientRect().x, remove: remove.getBoundingClientRect().x,
        weekly: row.querySelector('[data-window-minutes="10080"]')!.getBoundingClientRect().x };
    });
    for (const column of columns) for (const key of ['state', 'remove', 'weekly'] as const) {
      expect(Math.abs(column[key] - columns[0][key])).toBeLessThan(1);
    }
    expect(host.querySelector('[data-testid="model-current-layout-codex-b"]')?.textContent).toBe(locale === 'zh-CN' ? '使用中' : 'In use');
    expect(host.querySelector('[data-testid="model-switch-layout-codex-a"]')?.textContent).toBe(locale === 'zh-CN' ? '切换' : 'Switch');
    expect(host.querySelector('[data-testid="model-remove-native"]')).toBeNull();
    await page.screenshot({ element: host, path: `../../../../../../../test-results/coding-plan-rows-${locale}-${width}.png` });
  } finally {
    delete document.documentElement.dataset.theme;
  }
});

it.each(['claude', 'codex'])('Models keeps exactly one current $provider subscription and switches through the existing action', async provider => {
  await setLocalePreference('zh-CN');
  control.codex = true;
  control.connectionsByProvider[provider] = [
    { id: 'first-plan', kind: 'account', name: 'First plan', current: true },
    { id: 'second-plan', kind: 'account', name: 'Second plan', current: false },
  ];
  root.render(<ModelsFixture />);
  await until('the provider has one current account and one switch action', () => !!host.querySelector('[data-testid="model-switch-second-plan"]'));
  expect(host.querySelector('[data-testid="model-current-first-plan"]')?.textContent).toBe('使用中');
  await userEvent.click(page.getByTestId('model-switch-second-plan'));
  await until('the original select operation commits the other account', () => control.selected === 'second-plan');
  await until('the switched account becomes the only current account', () => !!host.querySelector('[data-testid="model-current-second-plan"]'));
  expect(host.querySelector('[data-testid="model-current-first-plan"]')).toBeNull();
});
it('Models offers Close and switch above the provider rows when working sessions refuse a switch', async () => {
  control.codex = true;
  control.connectionsByProvider.codex = [
    { id: 'first-plan', kind: 'account', name: 'First plan', current: true },
    { id: 'second-plan', kind: 'account', name: 'Second plan', current: false },
  ];
  control.rejectSelect = true;
  control.selectBusy = { providerId: 'codex', count: 2 };
  root.render(<ModelsFixture />);
  await until('the second model account can be selected', () => !!host.querySelector('[data-testid="model-switch-second-plan"]'));
  await userEvent.click(page.getByTestId('model-switch-second-plan'));
  await until('the existing close and switch action is shown', () => !!host.querySelector('[data-testid="subscription-close-and-switch"]'));
  expect(host.querySelector('[data-testid="model-current-first-plan"]')).not.toBeNull();
  await userEvent.click(page.getByTestId('subscription-close-and-switch'));
  await until('the original account switch retries with busy sessions explicitly stopped', () => control.stopBusySessions.length === 2);
  expect(control.stopBusySessions).toEqual([false, true]);
});
it('Models shows no switch or current label for a provider with one subscription', async () => {
  control.connectionsByProvider.claude = [{ id: 'only-plan', kind: 'account', name: 'Only plan', current: true }];
  root.render(<ModelsFixture />);
  await until('the single subscription row is read', () => !!host.querySelector('[data-subscription-model="claude:only-plan"]'));
  expect(host.querySelector('[data-testid="model-current-only-plan"]')).toBeNull();
  expect(host.querySelector('[data-testid="model-switch-only-plan"]')).toBeNull();
});


it.each(['claude', 'codex'].flatMap(provider => [{ provider, expired: true }, { provider, expired: false }]))('native $provider keeps a visible state and login entry with expired=$expired', async ({ provider, expired }) => {
  control.codex = true;
  control.signedOut = expired;
  control.expired = expired;
  control.connectionsByProvider[provider] = [{ id: 'native', kind: 'native', name: '', current: true }];
  root.render(<QueryClientProvider client={queryClient}><SessionLocalizationProvider><UiPortalContainerProvider value={layer}><CustomModelsGroup /></UiPortalContainerProvider></SessionLocalizationProvider></QueryClientProvider>);

  const row = () => host.querySelector(`[data-subscription-model="${provider}:native"]`);
  await until('the native row displays its actual state', () => row()?.textContent?.includes(expired ? 'Sign-in expired' : 'Signed in') === true);
  // Both providers have a native connection: scope the click to this provider, never pick the first match.
  await until('both native providers have their login entry', () => host.querySelectorAll('[data-testid="model-sign-in-native"]').length === 2);
  expect(row()!.querySelectorAll('[data-testid="model-sign-in-native"]')).toHaveLength(1);
  const signIn = row()!.querySelector<HTMLButtonElement>('[data-testid="model-sign-in-native"]');
  expect(signIn?.textContent).toBe('Sign in again');
  expect(row()!.querySelector('[data-testid="model-remove-native"]')).toBeNull();
  await userEvent.click(signIn!);
  await until('the same native connection signs in', () => modalStore.activeModalId === 'agentSignInModal');
  expect(control.created).toBeNull();
  expect(control.removed).toEqual([]);
  expect(control.selected).toBe('');
  expect(modalStore.activeModalArgs).toMatchObject({ providerId: provider, connectionId: 'native' });
  expect(thrown).toEqual([]);
});

it('shows a localized connection-read failure and retries the same real reading', async () => {
  setLocalePreference('zh-CN');
  control.connectionsError = true;
  root.render(<QueryClientProvider client={queryClient}><SessionLocalizationProvider><UiPortalContainerProvider value={layer}><CustomModelsGroup /></UiPortalContainerProvider></SessionLocalizationProvider></QueryClientProvider>);
  const card = () => host.querySelector('[data-testid="settings-coding-plans"]');
  await until('the model list reports the failed read', () => card()?.textContent?.includes('暂时无法读取 Claude Code 的连接。') === true);
  expect(card()?.textContent).not.toContain('Connections offline');
  control.connectionsError = false;
  const retry = [...card()!.querySelectorAll('button')].find(button => button.textContent === '重试')!;
  await userEvent.click(retry);
  await until('retry reads the existing connection', () => !!card()?.querySelector('[data-subscription-model="claude:native"]'));
  expect(thrown).toEqual([]);
});

it('groups subscription rows by their real provider and keeps row icons and subtitles out', async () => {
  control.codex = true;
  root.render(<ModelsFixture />);
  await until('both provider groups are read', () => host.querySelectorAll('[data-coding-provider]').length === 2);
  expect([...host.querySelectorAll('[data-coding-provider]')].map(group => group.getAttribute('data-coding-provider')))
    .toEqual(['chatgpt-subscription', 'claude-subscription']);
  expect(host.querySelectorAll('[data-subscription-model] .gg-settings-row-leading')).toHaveLength(0);
  // No source subtitle: a line under a name can only be the account's own state (the CLI's sign-in, beside its quota).
  for (const line of host.querySelectorAll('[data-subscription-model] .gg-settings-row-description')) expect(line.textContent).toBe('Signed in');
  expect(host.querySelectorAll('[data-testid="coding-plan-add"]')).toHaveLength(1);
});
it('renames a saved subscription with Enter and cancels a later edit with Escape', async () => {
  await setLocalePreference('zh-CN');
  control.connectionsByProvider.claude = [{ id: 'saved-name', kind: 'account', name: 'Before', current: true }];
  root.render(<ModelsFixture />);
  await until('the saved subscription has its editable name', () => !!host.querySelector('[data-subscription-model="claude:saved-name"] .gg-model-name'));
  await userEvent.click(page.getByRole('button', { name: '重命名 Before', exact: true }));
  await userEvent.fill(page.getByRole('textbox', { name: '重命名', exact: true }), 'After');
  await userEvent.keyboard('{Enter}');
  await until('the existing device mutation is reflected by the list', () => host.querySelector('[data-subscription-model="claude:saved-name"] .gg-model-name')?.textContent === 'After');
  expect(control.renamed).toEqual([{ providerId: 'claude', connectionId: 'saved-name', name: 'After' }]);
  expect(control.selected).toBe('');
  await userEvent.click(page.getByRole('button', { name: '重命名 After', exact: true }));
  await userEvent.fill(page.getByRole('textbox', { name: '重命名', exact: true }), 'Discarded');
  await userEvent.keyboard('{Escape}');
  expect(host.querySelector('[data-subscription-model="claude:saved-name"] .gg-model-name')?.textContent).toBe('After');
  expect(control.renamed).toHaveLength(1);
});
it('refreshes usage for every saved subscription without selecting an account', async () => {
  control.connectionsByProvider.claude = [
    { id: 'first-refresh', kind: 'account', name: 'First', current: true },
    { id: 'second-refresh', kind: 'account', name: 'Second', current: false },
  ];
  root.render(<ModelsFixture />);
  await until('the group is ready', () => !!host.querySelector('[data-subscription-model="claude:second-refresh"]'));
  await userEvent.click(page.getByTestId('coding-plan-refresh'));
  await until('both explicitly bound quota readings finish', () => control.forcedUsage.length === 2);
  expect(control.forcedUsage.sort()).toEqual(['first-refresh', 'second-refresh']);
  expect(control.selected).toBe('');
});
it.each([
  ['environment'], ['config-file'], [undefined],
] as const)('keeps the active native connection without a redundant origin label: %s', async (origin) => {
  await setLocalePreference('zh-CN');
  control.origin = origin;
  root.render(<ModelsFixture />);
  await until('the native configuration is listed', () => !!host.querySelector('[data-subscription-model="claude:native"]'));
  const row = host.querySelector('[data-subscription-model="claude:native"]')!;
  expect(row.textContent).toContain('现有 CLI 配置');
  expect(row.textContent).toContain('使用中');
  expect(row.textContent).not.toContain('环境变量');
  expect(row.textContent).not.toContain('配置文件');
});
