/**
 * 设置「订阅」页(product spec)在设置弹窗里 —— 会话页那棵树**外面** —— 真画出一行。
 *
 * 逐格那条(session-settings-content.test.tsx)只判「这一格提交了渲染」:那里宿主永远不回话，订阅页一行都画不出来，
 * 行里要用的东西缺了它也看不见。2026-10-13 真机实撞:行头的 harness 图标经会话页的 ThemeContext 读主题，
 * 弹窗里没有 ThemeProvider,一打开「订阅」整个壳落进「这个界面出错了」。这里让宿主答一家 agent 与它的两份读数，
 * 钉住「行与自动读取的用量条都画得出来」。
 */
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { until, untilStable } from '../../../../../../../tests/support/awaitCondition';
import { SessionSettingsContent } from '@renderer/features/settings/components/SettingsPage';
import { GuguSubscriptionRow } from '@renderer/features/settings/subscriptions/GuguSubscriptionRow';
import { AgentDetailModal } from '@renderer/features/settings/agents-page/AgentDetailModal';
import { CliAgentsList } from '@renderer/features/settings/agents-page/CliAgentsList';
import { SessionLocalizationProvider } from '@renderer/localization/localization-provider';
import { QueryClientProvider } from '@tanstack/react-query';
import { queryClient } from '@renderer/lib/query-client';
import { setLocalePreference } from '@/i18n';
import type { HarnessConnection } from '@gugu/session-core/workspace-server/agent-config';
import { modalStore } from '@renderer/lib/modal/modal-store';
import '@/styles/tokens.css';
import '@renderer/index.css';

const CLAUDE = { id: 'claude', name: 'Claude Code', reading: 'installed', status: 'available', capabilities: { auth: { kind: 'supported', methods: [{ kind: 'cli-login', id: 'claude-login', name: 'Claude', args: ['auth', 'login'] }] } } };
// #2507 其他家:Kimi 能在产品里登录(cli-login),Pi 没有任何登录方法。
const KIMI = { id: 'kimi', name: 'Kimi', reading: 'installed', status: 'available', capabilities: { auth: { kind: 'supported', methods: [{ kind: 'cli-login', id: 'kimi-login', name: 'Kimi', args: ['login'] }] } } };
const PI = { id: 'pi', name: 'Pi', reading: 'installed', status: 'available', capabilities: {} };
// #2507 API Key 连接:Qwen 声明了(地址 + 模型都必填,讲 OpenAI Chat Completions),Kiro 没有(只有它 CLI 自己的登录)。
const QWEN = { id: 'qwen', name: 'Qwen Code', reading: 'installed', status: 'available', capabilities: {
  apiKeyConnection: { kind: 'supported', endpoint: 'required', model: 'required', protocol: 'openai-chat-completions', evidence: 'test' },
} };
const KIRO = { id: 'kiro', name: 'Kiro', reading: 'installed', status: 'available', capabilities: {
  auth: { kind: 'supported', methods: [{ kind: 'cli-login', id: 'kiro-login', name: 'Kiro', args: ['login'] }] },
} };
// MiMo:两条路都有 —— 它 CLI 自己的登录(「现有 CLI 配置」)与官方 API Key(没有地址格)。
const MIMO = { id: 'mimocode', name: 'MiMo Code', reading: 'installed', status: 'available', capabilities: {
  auth: { kind: 'supported', methods: [{ kind: 'cli-login', id: 'mimo-login', name: 'MiMo', args: ['login'] }] },
  apiKeyConnection: { kind: 'supported', endpoint: 'none', model: 'none', evidence: 'test' },
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
  return {
    ...original,
    rpc: new Proxy({}, { get: (_, key) => (key === 'agents' ? agents : namespace) }),
    // 「关掉并切换」的进度由测试按主进程的样子推。
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
  selected: '',
  connections: [] as HarnessConnection[],
  codex: false,
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
    listConnections: async ({ providerId }: { providerId?: string } = {}) => control.connectionsError
      ? { success: false, error: { message: 'Connections offline' } }
      : { success: true, data: [...connectionsOf(providerId)] },
    refreshAuthStatus: async () => ({ success: true, data: control.signedOut ? { kind: 'unauthenticated', ...(control.expired ? { reason: 'expired' } : {}) } : { kind: 'authenticated', account: 'me@example.test' } }),
    createConnection: async (input: Record<string, unknown>) => {
      control.created = input;
      const connection: HarnessConnection = input.kind === 'account'
        ? { id: 'account-1', kind: 'account', name: 'Claude 1', current: false }
        : { id: 'api-1', kind: 'api-key', name: 'Saved API', endpoint: input.endpoint as string | undefined,
          ...(Array.isArray(input.models) ? { models: input.models as string[] } : {}), current: false };
      connectionsOf(input.providerId as string).push(connection);
      return { success: true, data: connection };
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
      // 「关掉并切换」= 正在工作的也关掉:宿主不再拒。
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
    readSubscription: async ({ providerId, connectionId }: { providerId?: string; connectionId?: string } = {}) => {
      if (control.hold) await control.hold;
      // 宿主对选中的 API Key 连接答它的地址(#2507),不去读 CLI 自己的文件。
      const keyed = connectionsOf(providerId).find(c => c.id === connectionId && c.kind === 'api-key');
      if (keyed) return { success: true, data: keyed.endpoint ? { payer: 'custom-endpoint', endpoint: new URL(keyed.endpoint).host } : { payer: 'api-key' } };
      return { success: true, data: control.signedOut ? { payer: 'not-signed-in' } : { payer: 'subscription', plan: 'Claude Max 20x' } };
    },
    readSubscriptionUsage: async ({ connectionId }: { connectionId?: string }) => ({
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
    }),
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

beforeEach(() => {
  queryClient.clear();
  control.hold = null;
  control.membershipError = false;
  control.held = 0;
  control.created = null;
  control.removed = [];
  control.selected = '';
  control.codex = false;
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

it.each(['claude', 'codex'])('an unsigned native %s connection preserves selection of a saved API', async provider => {
  control.codex = true;
  control.signedOut = true;
  control.connections.push({ id: 'saved-api', kind: 'api-key', name: 'Saved API', current: false });
  root.render(<SessionSettingsContent section="subscriptions" portalContainer={layer} />);
  await until('the harness connection action is ready', () => !!host.querySelector(`[data-testid="subscription-switch-${provider}"]`));
  await openSwitch(provider);
  await until('the connection action opens', () => !!layer.querySelector('.subscription-connection-form, [data-testid="connection-saved-api"]'));
  expect(layer.querySelector('.subscription-connection-form')).toBeNull();
  await until('the saved API can be selected', () => layer.querySelector('[data-testid="connection-use-saved-api"]')?.hasAttribute('data-disabled') === false);
  await userEvent.click(page.getByTestId('connection-use-saved-api'));
  await until('the existing API is selected', () => control.selected === 'saved-api');
  expect(control.created).toBeNull();
  expect(thrown).toEqual([]);
});

it.each(['claude', 'codex'])('an expired current %s account offers "Sign in again" on the row itself, without opening any menu', async provider => {
  control.codex = true;
  control.signedOut = true;
  control.expired = true;
  control.connections = [{ id: 'expired-account', kind: 'account', name: 'Saved account', current: true }];
  root.render(<SessionSettingsContent section="subscriptions" portalContainer={layer} />);
  await until('the sign-in action is on the row', () => !!host.querySelector(`[data-testid="subscription-sign-in-${provider}"]`));
  const button = host.querySelector(`[data-testid="subscription-sign-in-${provider}"]`) as HTMLButtonElement;
  expect(button.textContent).toBe('Sign in again');
  button.click();
  expect(modalStore.activeModalId).toBe('agentSignInModal');
  expect(modalStore.activeModalArgs).toMatchObject({ providerId: provider, connectionId: 'expired-account' });
  expect(thrown).toEqual([]);
});

it('a signed-in account and the native CLI configuration get no sign-in button on the row', async () => {
  control.connections = [{ id: 'account', kind: 'account', name: 'Saved account', current: true }];
  root.render(<SessionSettingsContent section="subscriptions" portalContainer={layer} />);
  await until('the harness connection action is ready', () => !!host.querySelector('[data-testid="subscription-switch-claude"]'));
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(host.querySelector('[data-testid="subscription-sign-in-claude"]')).toBeNull();
});

it.each(['claude', 'codex'])('an expired saved %s account preserves its sign-in menu', async provider => {
  control.codex = true;
  control.signedOut = true;
  control.expired = true;
  control.connections = [{ id: 'expired-account', kind: 'account', name: 'Saved account', current: true }];
  root.render(<SessionSettingsContent section="subscriptions" portalContainer={layer} />);
  await openSwitch(provider);
  await until('the connection list opens', () => !!layer.querySelector('[data-testid="connection-expired-account"]'));
  expect(host.querySelector('.subscription-connection-form')).toBeNull();
  await userEvent.click(page.getByRole('button', { name: 'Options for Saved account', exact: true }));
  const signIn = page.getByRole('menuitem', { name: 'Sign in', exact: true });
  await expect.element(signIn).toBeVisible();
  await untilStable('the saved account sign-in menu settles', () => {
    const { x, y, width, height } = signIn.element().getBoundingClientRect();
    return { x, y, width, height };
  });
  await userEvent.click(signIn);
  expect(modalStore.activeModalId).toBe('agentSignInModal');
  expect(modalStore.activeModalArgs).toMatchObject({ providerId: provider, connectionId: 'expired-account' });
  expect(control.created).toBeNull();
  expect(thrown).toEqual([]);
});

// owner 2026-11-12:「我没有配置啊……你为什么要有一个占位呢」—— 没登上的「现有 CLI 配置」不列;这一行写「未登录」,
// 当前连接写「没有」,只给「添加连接」,点了就地是表单(与资源库详情同一块)。
it.each(['claude', 'codex'])('an unsigned native %s connection is not listed; Add connection opens the form in place', async provider => {
  control.codex = true;
  control.signedOut = true;
  root.render(<SessionSettingsContent section="subscriptions" portalContainer={layer} />);
  await until('the unconfigured harness has an add action', () => !!addButton(provider) && !!noConnection(provider));
  const row = host.querySelector(`[data-testid="subscription-row-${provider}"]`)!;
  expect(noConnection(provider)?.textContent).toBe('None');
  expect(switchTrigger(provider)).toBeNull();
  await until('the row says it is not signed in', () => row.querySelector(`[data-testid="connection-status-${provider}"]`)?.textContent === 'Not signed in');
  expect(row.textContent).not.toContain('Existing CLI configuration');
  expect(host.textContent).not.toContain('Library');
  addButton(provider)!.click();
  await until('the connection form opens in Settings', () => !!row.querySelector('.subscription-connection-form'));
  expect(methodButtons()).toEqual(['Account sign-in', 'API Key']);
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
  root.render(<SessionSettingsContent section="subscriptions" portalContainer={layer} />);
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
  root.render(<SessionSettingsContent section="subscriptions" portalContainer={layer} />);
  await until('the Kimi row offers Add connection', () => !!addButton('kimi') && !!noConnection('kimi'));
  await until('the Pi row is drawn', () => !!host.querySelector('[data-testid="subscription-row-pi"]'));
  // 一个入口:❌ 行上另一颗「登录」。
  expect(host.querySelector('[data-testid="subscription-sign-in-kimi"]')).toBeNull();
  // 这一份 Pi 两样都没有(没声明登录,也没有 API Key):不画「连接」那一块,❌ 摆一颗登不上的按钮。
  const pi = host.querySelector('[data-testid="subscription-row-pi"]')!;
  expect(pi.querySelector('[data-testid="connection-block-pi"]')).toBeNull();
  expect(pi.querySelector('button')).toBeNull();
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

// #2507 owner 2026-11-12:每家的登录 = Claude / Codex 那套「连接」。Qwen 没有账号登录,只有 API Key:
// 地址与模型都必填、地址下一行说它要讲什么接口;Kiro 没有 key 的路,只有它 CLI 自己的「登录」。
it('a Qwen row adds an API key connection with address and model and switches to it; a Kiro row has no API key option', async () => {
  control.keyed = true;
  control.signedOut = true;
  control.connectionsByProvider.qwen = [{ id: 'native', kind: 'native', name: '', current: true }];
  root.render(<SessionSettingsContent section="subscriptions" portalContainer={layer} />);
  await until('the Qwen row has its add action', () => !!addButton('qwen') && !!noConnection('qwen'));
  await until('the Kiro row has its add action', () => !!addButton('kiro'));
  // Qwen 没有账号登录可点(厂商删了),❌ 摆一个登不了的「登录」。
  expect(host.querySelector('[data-testid="subscription-sign-in-qwen"]')).toBeNull();
  // Kiro:只有 CLI 自己的登录 ——「添加连接」里只有「账号」,没有 API Key。
  addButton('kiro')!.click();
  await until('the Kiro form opens', () => !!host.querySelector('[data-testid="subscription-row-kiro"] .subscription-connection-form'));
  expect(methodButtons()).toEqual([]);
  expect(host.querySelector('[data-testid="subscription-row-kiro"] .subscription-connection-form button[type="submit"]')?.textContent).toBe('Sign in');
  ([...host.querySelectorAll<HTMLButtonElement>('[data-testid="subscription-row-kiro"] button')].find(b => b.textContent === 'Cancel'))!.click();
  await until('the Kiro form closes', () => !host.querySelector('.subscription-connection-form'));

  addButton('qwen')!.click();
  await until('the connection form opens', () => !!host.querySelector('.subscription-connection-form'));
  const form = host.querySelector('.subscription-connection-form') as HTMLFormElement;
  // 只有 API Key 一种方式;地址直接摆出来(没有「第三方」勾选);模型必填;地址下一行说接口。
  // 只有 API Key 一种方式:不画分段,直接是 API Key 表单。
  expect(form.querySelectorAll('[role="tab"]')).toHaveLength(0);
  expect(form.querySelector('input[name="apiKey"]')).not.toBeNull();
  expect(form.querySelector('input[type="checkbox"]')).toBeNull();
  expect(form.querySelector('input[name="endpoint"]')?.hasAttribute('required')).toBe(true);
  // 模型 ❌ 一个必填文本框:从地址读清单、多选(#2507 第 6 轮)。
  expect(form.querySelector('input[name="model"]')).toBeNull();
  expect(form.querySelector('[data-testid="connection-models"]')).not.toBeNull();
  expect(form.textContent).toContain('This address must support the OpenAI Chat Completions API');

  await userEvent.fill(page.getByLabelText('API Key', { exact: true }), 'test-api-key');
  await userEvent.fill(page.getByRole('textbox', { name: 'API address', exact: true }), 'https://dashscope.example/v1');
  const models = page.getByRole('combobox', { name: 'Models', exact: true });
  await expect.element(models).toBeEnabled();
  await userEvent.click(models);
  await userEvent.click(page.getByRole('option', { name: 'qwen3-coder-plus', exact: true }));
  await until('the model is ticked', () => form.querySelector('[data-slot="combobox-chip"]')?.textContent === 'qwen3-coder-plus');
  form.requestSubmit();
  // 当前是「没有」:存好的这一把直接成为当前连接(走切换那条路),❌ 再让人去列表里选一次。
  await until('the saved key becomes the current connection', () => control.selected === 'api-1');
  expect(control.created).toEqual({
    providerId: 'qwen',
    kind: 'api-key',
    apiKey: 'test-api-key',
    endpoint: 'https://dashscope.example/v1',
    models: ['qwen3-coder-plus'],
  });
  await until('the select names the new key', () => switchTrigger('qwen')?.textContent === 'Saved API');
  await openSwitch('qwen');
  await until('the saved connection is listed', () => layer.querySelector('[data-testid="connection-api-1"]') !== null);
  expect(layer.querySelector('[data-testid="connection-api-1"]')?.textContent).toContain('dashscope.example · qwen3-coder-plus');
  await userEvent.keyboard('{Escape}');

  // 选中之后这一行就是这把 key:API 角标、连接名,❌「未登录」,❌「登录」。
  const row = () => host.querySelector('[data-testid="subscription-row-qwen"]') as HTMLElement;
  await until('the row reads the selected API key connection', () => row().textContent?.includes('Saved API') === true);
  await until('the row shows the API badge', () => row().querySelector('.subscription-plan-badge')?.textContent === 'API');
  expect(row().textContent).not.toContain('Not signed in');
  expect(row().querySelector('[data-testid="subscription-sign-in-qwen"]')).toBeNull();
  expect(layer.textContent).not.toContain('test-api-key');
  expect(thrown).toEqual([]);
});

// #2507:选中 API Key 连接后这一行就是这把 key ——❌「未登录」;没登上的「现有 CLI 配置」不列(owner 2026-11-12)。
// 「账号」(登它 CLI 自己那一份)用着 API Key 时也在(owner 2026-11-12「要一直都在」):登录恒按原生起(主进程那一层)。
it('selecting an API key connection takes Not signed in off the row; the unsigned CLI configuration is never listed', async () => {
  control.keyed = true;
  control.signedOut = true;
  control.connectionsByProvider.mimocode = [
    { id: 'native', kind: 'native', name: '', current: true },
    { id: 'mimo-key', kind: 'api-key', name: 'MiMo key', current: false },
  ];
  root.render(<SessionSettingsContent section="subscriptions" portalContainer={layer} />);
  const row = () => host.querySelector('[data-testid="subscription-row-mimocode"]') as HTMLElement;
  await until('the MiMo row reads the key it has', () => switchTrigger('mimocode')?.hasAttribute('data-disabled') === false);
  await until('the row says it is not signed in', () => row().querySelector('[data-testid="connection-status-mimocode"]')?.textContent === 'Not signed in');
  expect(switchTrigger('mimocode')?.textContent).toBe('None');
  expect(row().querySelector('[data-testid="subscription-sign-in-mimocode"]')).toBeNull();
  addButton('mimocode')!.click();
  await until('the form opens', () => !!row().querySelector('.subscription-connection-form'));
  expect(methodButtons()).toEqual(['Account sign-in', 'API Key']);
  ([...row().querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === 'Cancel'))!.click();

  await openSwitch('mimocode');
  await until('the key can be selected', () => layer.querySelector('[data-testid="connection-use-mimo-key"]')?.hasAttribute('data-disabled'), disabled => disabled === false);
  expect(layer.querySelector('[data-testid="connection-native"]')).toBeNull();
  await userEvent.click(page.getByTestId('connection-use-mimo-key'));
  await until('the key is selected', () => control.selected === 'mimo-key');
  await until('the row reads the key', () => row().querySelector('.subscription-plan-badge')?.textContent === 'API');
  expect(row().textContent).toContain('MiMo key');
  expect(row().textContent).not.toContain('Not signed in');
  addButton('mimocode')!.click();
  await until('the form opens again', () => !!row().querySelector('.subscription-connection-form'));
  expect(methodButtons()).toEqual(['Account sign-in', 'API Key']);
  // 选着 key 登的仍是 CLI 自己那一份:登录窗口读「现有 CLI 配置」那一格,选择不动。
  ([...row().querySelectorAll<HTMLButtonElement>('.subscription-connection-form button')].find(b => b.textContent === 'Sign in'))!.click();
  await until('the sign-in window opens', () => modalStore.activeModalId === 'agentSignInModal');
  expect(modalStore.activeModalArgs).toMatchObject({ providerId: 'mimocode', connectionId: 'native', steps: [{ methodId: 'mimo-login', transport: 'terminal' }] });
  expect(control.selected).toBe('mimo-key');
  expect(thrown).toEqual([]);
});

it.each(['claude', 'codex'])('an empty %s connection list opens Add connection directly', async provider => {
  control.codex = true;
  control.signedOut = true;
  control.connections = [];
  root.render(<SessionSettingsContent section="subscriptions" portalContainer={layer} />);
  await until('the empty connection list has an add action', () => !!addButton(provider) && !!noConnection(provider));
  expect(switchTrigger(provider)).toBeNull();
  addButton(provider)!.click();
  await until('the existing connection form opens directly', () => !!host.querySelector('.subscription-connection-form'));
  expect(layer.querySelector('[role="menu"], [role="listbox"]')).toBeNull();
  expect(control.created).toBeNull();
  expect(thrown).toEqual([]);
});

it('draws a harness row with its plan, both quota windows without an extra query button outside the task page tree', async () => {
  root.render(<SessionSettingsContent section="subscriptions" portalContainer={layer} />);
  await until('the Claude row shows its usage (or the tree threw)', () =>
    thrown.length > 0 || host.querySelector('[data-testid="subscription-usage-claude"]') !== null
  );
  expect(thrown).toEqual([]);
  // 图标那一层真画出来了(否则这条判不出 2026-10-13 那次的「缺主题 context」)。
  await until('the harness mark is drawn', () => host.querySelector('[data-testid="app-icon"] svg') !== null);
  const row = host.querySelector('[data-testid="subscription-row-claude"]') as HTMLElement;
  expect(row.textContent).toContain('Claude Max 20x');
  expect(row.querySelectorAll('[role="meter"]')).toHaveLength(2);
  expect(row.querySelector('[data-testid="subscription-check-now-claude"]')).toBeNull();
});

it('「刷新」读着的时候按不动、读完回来 —— 跟着读数变，不是只在列表碰巧重画时才变', async () => {
  root.render(<SessionSettingsContent section="subscriptions" portalContainer={layer} />);
  await until('the Claude row shows its usage', () => host.querySelector('[data-testid="subscription-usage-claude"]') !== null);
  const refresh = () => host.querySelector('[data-testid="subscriptions-refresh"]') as HTMLButtonElement;
  await until('the first reads settle', () => refresh().disabled, (disabled) => !disabled);

  let release!: () => void;
  control.hold = new Promise<void>((resolve) => (release = resolve));
  refresh().click();
  await until('「刷新」 shows it is reading', () => refresh().disabled);
  control.hold = null;
  release();
  await until('「刷新」 comes back once the read is in', () => refresh().disabled, (disabled) => !disabled);
  expect(thrown).toEqual([]);
});


it('Gugu Free shares the same collection and membership errors are never shown as Free', async () => {
  control.membershipError = true;
  root.render(<SessionSettingsContent section="subscriptions" portalContainer={layer} />);
  await until('membership error is visible', () => host.querySelector('[data-testid="subscription-row-gugu"]')?.textContent?.includes('offline') === true);
  const gugu = host.querySelector('[data-testid="subscription-row-gugu"]')!;
  expect(gugu.querySelector('.subscription-plan-badge')).toBeNull();
  // The Claude row comes from its own provider read; it can land after the Gugu row.
  await until('the Claude row is listed', () => host.querySelector('[data-testid="subscription-row-claude"]') !== null);
  expect(gugu.parentElement).toBe(host.querySelector('[data-testid="subscription-row-claude"]')!.parentElement);
  expect(thrown).toEqual([]);
});

it('adds a relay API over the prefilled official address and explicitly switches the connection without opening Agent creation', async () => {
  root.render(<SessionSettingsContent section="subscriptions" portalContainer={layer} />);
  await until('the add action is ready', () => addButton('claude') !== null);
  addButton('claude')!.click();
  await until('connection method choices are visible', () => [...host.querySelectorAll('button')].some(b => b.textContent === 'API Key'));
  ([...host.querySelectorAll('button')].find(b => b.textContent === 'API Key') as HTMLButtonElement).click();
  await until('API form is visible', () => host.querySelector('input[name="apiKey"]') !== null);
  // 地址 + Key 是主体(owner 2026-11-12):地址一直摆着、一开始就是 Anthropic 官方地址;❌「使用第三方 API」勾选。中转就改掉它。
  expect(host.querySelector('.subscription-connection-form input[type="checkbox"]')).toBeNull();
  expect((host.querySelector('input[name="endpoint"]') as HTMLInputElement).value).toBe('https://api.anthropic.com');
  expect(host.querySelector('input[name="endpoint"]')?.hasAttribute('required')).toBe(false);
  (host.querySelector('input[name="apiKey"]') as HTMLInputElement).value = 'test-api-key';
  (host.querySelector('input[name="endpoint"]') as HTMLInputElement).value = 'https://gateway.example/v1';
  (host.querySelector('.subscription-connection-form') as HTMLFormElement).requestSubmit();
  await until('the form folds back', () => host.querySelector('.subscription-connection-form') === null);
  expect(control.created).toMatchObject({ providerId: 'claude', kind: 'api-key', apiKey: 'test-api-key', endpoint: 'https://gateway.example/v1' });
  expect(control.selected).toBe('');
  // 已有当前连接:❌ 自己把列表弹开;新的一条在列表里,点开才看得到,切换要人自己选。
  expect(layer.querySelector('[data-testid="connection-api-1"]')).toBeNull();
  await openSwitch('claude');
  await until('saved connection appears', () => layer.querySelector('[data-testid="connection-api-1"]') !== null);
  await until('connection can be selected', () => layer.querySelector('[data-testid="connection-use-api-1"]')?.hasAttribute('data-disabled'), disabled => disabled === false);
  await userEvent.click(page.getByTestId('connection-use-api-1'));
  await until('the selected connection is acknowledged', () => control.selected === 'api-1');
  expect(control.selected).toBe('api-1');
  expect(layer.textContent).not.toContain('test-api-key');
  expect(thrown).toEqual([]);
});


it.each([390, 720, 1120])('Gugu credits fit a %s px settings container with a prominent total and compact recharge action', async width => {
  host.style.cssText = `width: ${width}px; container: gg-settings / inline-size`;
  root.render(<GuguSubscriptionRow />);
  await until('the Gugu balances render', () => host.querySelector('[data-testid="subscription-credits-balance"]')?.textContent?.includes('8.2') ?? false);
  const row = host.querySelector<HTMLElement>('[data-testid="subscription-row-gugu"]')!;
  const quotas = [...row.querySelectorAll<HTMLElement>('.subscription-quota')];
  await untilStable('the credit layout is measured', () => quotas.map(q => q.getBoundingClientRect().top).join(','));
  const period = quotas[0].getBoundingClientRect();
  const wallet = quotas[1].getBoundingClientRect();
  const walletLabel = quotas[1].querySelector('span')!;
  const walletCredits = quotas[1].querySelector('strong')!;
  expect(walletLabel.textContent).toMatch(/^(不过期积分|Non-expiring credits)$/);
  const labelRect = walletLabel.getBoundingClientRect();
  const creditsRect = walletCredits.getBoundingClientRect();
  expect(creditsRect.left - labelRect.right).toBeCloseTo(8, 0);
  expect(Math.abs(creditsRect.top - labelRect.top)).toBeLessThan(8);
  const total = row.querySelector<HTMLElement>('[data-testid="subscription-credits-balance"]')!;
  expect(parseFloat(getComputedStyle(total).fontSize)).toBeGreaterThan(parseFloat(getComputedStyle(quotas[0].querySelector('strong')!).fontSize));
  expect(total.getBoundingClientRect().bottom).toBeLessThanOrEqual(period.top);
  const recharge = row.querySelector<HTMLElement>('[data-testid="membership-open-web"]')!;
  expect(recharge.getAttribute('href')).toBe('https://gugu.nextmind.space/dashboard/#topup');
  expect(row.querySelector('a')?.getAttribute('href')).toBe('https://gugu.nextmind.space/dashboard/');
  expect(recharge.getBoundingClientRect().width).toBeLessThan(row.clientWidth * 0.7);
  expect(row.querySelector('[data-testid="subscription-billing-copy"]')).toBeNull();
  if (width === 390) {
    expect(wallet.top).toBeGreaterThanOrEqual(period.bottom);
    expect(Math.abs(wallet.left - period.left)).toBeLessThanOrEqual(1);
    const reset = quotas[0].querySelector('p')!.getBoundingClientRect();
    expect(Math.abs(reset.left - period.left)).toBeLessThanOrEqual(1);
    expect(row.scrollWidth).toBeLessThanOrEqual(row.clientWidth);
  } else {
    expect(Math.abs(wallet.top - period.top)).toBeLessThanOrEqual(1);
    expect(wallet.left).toBeGreaterThan(period.right);
  }
});

it('explains reserved credits when the available total differs from the two balances', async () => {
  control.held = 1;
  root.render(<SessionSettingsContent section="subscriptions" portalContainer={layer} />);
  await until('the reservation is shown', () => /预留|reserved/.test(host.querySelector('[data-testid="subscription-row-gugu"]')?.textContent ?? ''));
  expect(host.querySelector('[data-testid="subscription-row-gugu"]')?.textContent).toContain('7.2');
});

it('Codex shows both the five-hour and weekly windows directly on opening subscriptions', async () => {
  control.codex = true;
  root.render(<SessionSettingsContent section="subscriptions" portalContainer={layer} />);
  await until('Codex quota is visible without any click', () => host.querySelector('[data-testid="subscription-usage-codex"]') !== null);
  const row = host.querySelector('[data-testid="subscription-row-codex"]')!;
  expect(row.querySelector('[role="meter"][aria-label="5 小时"], [role="meter"][aria-label="5 hours"]')).not.toBeNull();
  expect(row.querySelectorAll('[role="meter"]')).toHaveLength(2);
  expect(row.querySelector('[data-testid="subscription-check-now-codex"]')).toBeNull();
  expect(thrown).toEqual([]);
});

it('a failed connection read shows its failure instead of staying in the loading state', async () => {
  control.connectionsError = true;
  root.render(<SessionSettingsContent section="subscriptions" portalContainer={layer} />);
  await until('the row shows the connection error', () => host.querySelector('[data-testid="subscription-row-claude"]')?.textContent?.includes('Connections offline') === true);
  expect(host.querySelector('[data-testid="subscription-row-claude"]')?.textContent).not.toMatch(/正在读|Reading[.…]|Checking/);
});

it('a failed dropdown switch keeps the previous current connection', async () => {
  control.rejectSelect = true;
  control.connections.push({ id: 'saved-api', kind: 'api-key', name: 'Saved API', current: false });
  root.render(<SessionSettingsContent section="subscriptions" portalContainer={layer} />);
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
it('a long switch refusal is shown under the row heading and does not squeeze the account column', async () => {
  control.codex = true;
  control.rejectSelect = true;
  control.selectMessage = '6 Codex sessions are still working. Switch the subscription after they finish; switching restarts every running Codex session.';
  control.connections.push({ id: 'saved-api', kind: 'api-key', name: 'Saved API', current: false });
  // 视口比这一页宽:量的是 720 那一栏自己的排版,❌ 视口窄到出滚动条时整栏换成竖排的那一下。
  await page.viewport(1100, 900);
  host.style.width = '720px';
  root.render(<SessionSettingsContent section="subscriptions" portalContainer={layer} />);
  await until('the Codex switch is ready', () => switchTrigger('codex') !== null);
  const row = host.querySelector('[data-testid="subscription-row-codex"]') as HTMLElement;
  const identity = () => row.querySelector('[data-testid="connection-status-codex"]') as HTMLElement;
  // 状态那一行所在的那一列(当前连接那一行的正文)。
  const column = () => identity().closest('.gg-settings-row-body') as HTMLElement;
  await until('the account line is drawn', () => (identity()?.textContent ?? '').includes('me@example.test'));
  // 连接数读回来之后右列的文案才定下来(「当前设备」→「当前设备 · 2 个连接」);等它稳了再量。
  await until('the connection count is shown', () => row.querySelector('.subscription-scope')?.textContent?.includes('2') === true);
  await untilStable('the account column settles', () => Math.round(column().getBoundingClientRect().width));
  const widthBefore = column().getBoundingClientRect().width;
  const switchBefore = switchTrigger('codex')!.getBoundingClientRect();
  expect(widthBefore).toBeGreaterThan(150);
  expect(row.querySelector('[role="alert"]')).toBeNull();

  await openSwitch('codex');
  await until('the saved API option can be used', () => layer.querySelector('[data-testid="connection-use-saved-api"]')?.hasAttribute('data-disabled'), disabled => disabled === false);
  await userEvent.click(page.getByTestId('connection-use-saved-api'));
  await until('the refusal is displayed', () => row.textContent?.includes('6 Codex sessions are still working') === true);

  const alert = row.querySelector('[role="alert"]') as HTMLElement;
  const card = row.getBoundingClientRect();
  const heading = row.querySelector('.subscription-service-heading')!.getBoundingClientRect();
  const message = alert.getBoundingClientRect();
  expect(column().getBoundingClientRect().width).toBeCloseTo(widthBefore, 0);
  const switchAfter = switchTrigger('codex')!.getBoundingClientRect();
  expect(switchAfter.width).toBeCloseTo(switchBefore.width, 0);
  expect(switchAfter.left).toBeCloseTo(switchBefore.left, 0);
  expect(message.top).toBeGreaterThanOrEqual(identity().getBoundingClientRect().bottom - 0.5);
  expect(message.top).toBeGreaterThanOrEqual(heading.bottom - 0.5);
  expect(message.left).toBeGreaterThanOrEqual(card.left);
  expect(message.right).toBeLessThanOrEqual(card.right + 0.5);
  expect(control.connections.find(c => c.current)?.id).toBe('native');

  // 下一次动作一开始,上一次的原因就撤掉;这次成功了,行里不再留着旧的拒绝。
  control.rejectSelect = false;
  if (!layer.querySelector('[data-testid="connection-use-saved-api"]')) await openSwitch('codex');
  await until('the saved API option can be used again', () => layer.querySelector('[data-testid="connection-use-saved-api"]')?.hasAttribute('data-disabled'), disabled => disabled === false);
  await userEvent.click(page.getByTestId('connection-use-saved-api'));
  await until('the refusal is gone once a switch goes through', () => row.querySelector('[role="alert"]') === null);
  expect(control.selected).toBe('saved-api');
  expect(thrown).toEqual([]);
  await page.viewport(414, 896);
});


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
  control.connections.push({ id: 'saved-api', kind: 'api-key', name: 'Saved API', current: false });
  host.style.width = '720px';
  root.render(<SessionSettingsContent section="subscriptions" portalContainer={layer} />);
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
  control.connections.push({ id: 'saved-api', kind: 'api-key', name: 'Saved API', current: false });
  host.style.width = '720px';
  root.render(<SessionSettingsContent section="subscriptions" portalContainer={layer} />);
  await until('the Codex switch is ready', () => host.querySelector('[data-testid="subscription-switch-codex"]') !== null);
  const row = host.querySelector('[data-testid="subscription-row-codex"]') as HTMLElement;
  await openSwitch('codex');
  await until('the saved API option can be used', () => layer.querySelector('[data-testid="connection-use-saved-api"]')?.hasAttribute('data-disabled'), disabled => disabled === false);
  (layer.querySelector('[data-testid="connection-use-saved-api"]') as HTMLElement).click();
  await until('the refusal offers to close and switch', () => row.querySelector('[data-testid="subscription-close-and-switch"]') !== null);
  const closeAndSwitch = row.querySelector('[data-testid="subscription-close-and-switch"]') as HTMLButtonElement;
  expect(closeAndSwitch.textContent).toBe('关掉并切换');
  expect(control.stopBusySessions).toEqual([false]);
  expect(control.connections.find(c => c.current)?.id).toBe('native');

  // 关的这段时间(等进程退出)原地说正在做什么,按钮收起，不留一片空白。
  let release!: () => void;
  control.closeHold = new Promise<void>((resolve) => (release = resolve));
  closeAndSwitch.click();
  await until('the row says it is closing', () => row.querySelector('.subscription-switch-progress')?.textContent?.startsWith('正在关掉 Codex 会话，关完就切换') === true);
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
  control.connections.push({ id: 'saved-api', kind: 'api-key', name: 'Saved API', current: false });
  root.render(<SessionSettingsContent section="subscriptions" portalContainer={layer} />);
  await until('the Codex switch is ready', () => host.querySelector('[data-testid="subscription-switch-codex"]') !== null);
  const row = host.querySelector('[data-testid="subscription-row-codex"]') as HTMLElement;
  await openSwitch('codex');
  await until('the saved API option can be used', () => layer.querySelector('[data-testid="connection-use-saved-api"]')?.hasAttribute('data-disabled'), disabled => disabled === false);
  (layer.querySelector('[data-testid="connection-use-saved-api"]') as HTMLElement).click();
  await until('the refusal offers to close and switch', () => row.querySelector('[data-testid="subscription-close-and-switch"]') !== null);
  (row.querySelector('[data-testid="subscription-close-and-switch"]') as HTMLButtonElement).click();
  await until('the outdated host is named', () => row.querySelector('[role="alert"]') !== null);
  expect(row.querySelector('[role="alert"]')?.textContent).toBe('那台机器上的咕咕版本太旧，关不掉正在工作的会话。更新后再切换。');
  expect(row.querySelector('[data-testid="subscription-close-and-switch"]')).toBeNull();
  expect(control.stopBusySessions).toEqual([false, true]);
  expect(control.connections.find(c => c.current)?.id).toBe('native');
});

it('a real failure is red and offers no close-and-switch', async () => {
  control.codex = true;
  control.rejectSelect = true;
  control.selectMessage = 'Sign in before using this connection';
  control.connections.push({ id: 'saved-api', kind: 'api-key', name: 'Saved API', current: false });
  root.render(<SessionSettingsContent section="subscriptions" portalContainer={layer} />);
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
  root.render(<SessionSettingsContent section="subscriptions" portalContainer={layer} />);
  // The switch is there (disabled) while the connections are read; press it once it is usable, as a person would.
  await openSwitch('codex');
  await until('the other account shows its quota', () => layer.querySelector('[data-testid="connection-quota-second"]') !== null);
  const second = layer.querySelector('[data-testid="connection-quota-second"]') as HTMLElement;
  expect(second.textContent).toBe('5 小时剩余 90% · 每周剩余 65%');
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
])('an authenticated $provider $kind connection has no login or reauthorization action', async ({ provider, kind }) => {
  control.codex = true;
  control.connections = [{ id: 'existing', kind, name: 'Existing account', current: true }];
  root.render(<SessionSettingsContent section="subscriptions" portalContainer={layer} />);
  await openSwitch(provider);
  await until('the account has been read', () => layer.querySelector('[data-testid="connection-existing"]')?.textContent?.includes('me@example.test') === true);
  const existing = layer.querySelector('[data-testid="connection-existing"]')!;
  if (kind === 'native') {
    // 「现有 CLI 配置」是 CLI 自己那一份:没有「⋯」。
    expect(existing.querySelector('[aria-haspopup="menu"]')).toBeNull();
  } else {
    // 账号连接的「⋯」里只有「移除」(#2507:正在用的也能删,落回原生),没有登录 / 重新授权。
    await userEvent.click(page.getByRole('button', { name: 'Options for Existing account', exact: true }));
    await until('its options open', () => layer.querySelectorAll('[role="menuitem"]').length > 0);
    expect([...layer.querySelectorAll('[role="menuitem"]')].map(item => item.textContent)).toEqual(['Remove']);
  }
  expect(host.querySelector(`[data-testid="subscription-sign-in-${provider}"]`)).toBeNull();
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
])('%s (signed out: %s) renders the same status line and Connections block on the subscription row and in the Library detail', async (provider, signedOut) => {
  control.codex = true;
  control.keyed = true;
  control.signedOut = signedOut;
  control.connectionsByProvider.mimocode = [
    { id: 'native', kind: 'native', name: '', current: true },
    { id: 'mimo-key', kind: 'api-key', name: 'MiMo key', current: false },
  ];
  control.connectionsByProvider.qwen = [{ id: 'native', kind: 'native', name: '', current: true }];
  const detailHost = document.createElement('div');
  detailHost.className = 'gugu-skin emlight';
  document.body.append(detailHost);
  const detailRoot = createRoot(detailHost);
  root.render(<SessionSettingsContent section="subscriptions" portalContainer={layer} />);
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
it('lists the same installed agents in the same order as the Library', async () => {
  control.codex = true;
  control.others = true;
  control.keyed = true;
  const libraryHost = document.createElement('div');
  document.body.append(libraryHost);
  const libraryRoot = createRoot(libraryHost);
  root.render(<SessionSettingsContent section="subscriptions" portalContainer={layer} />);
  libraryRoot.render(
    <QueryClientProvider client={queryClient}>
      <SessionLocalizationProvider>
        <CliAgentsList selectedAgentId={null} onSelectAgent={() => {}} />
      </SessionLocalizationProvider>
    </QueryClientProvider>
  );
  try {
    const subscriptionOrder = () => [...host.querySelectorAll('[data-testid^="subscription-row-"]')]
      .map(row => row.getAttribute('data-testid')!.replace('subscription-row-', ''))
      .filter(id => id !== 'gugu');
    const libraryOrder = () => [...libraryHost.querySelectorAll('[data-testid="agent-group-installed"] [data-testid^="agent-tile-"]')]
      .map(tile => tile.getAttribute('data-testid')!.replace('agent-tile-', ''));
    await until('both lists are drawn', () => subscriptionOrder().length === 7 && libraryOrder().length === 7);
    expect(subscriptionOrder()).toEqual(libraryOrder());
    expect(subscriptionOrder()).toEqual(['claude', 'codex', 'pi', 'kimi', 'kiro', 'mimocode', 'qwen']);
  } finally {
    libraryRoot.unmount();
    libraryHost.remove();
  }
});
