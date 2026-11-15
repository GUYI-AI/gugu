/**
 * #2507 宿主这一层(renderer ↔ worker 之间)的两件事,走真的连接表与真的 run context 解析:
 *
 *  1. 「添加连接 → 账号」登的是 CLI 自己那一份:选着一把 API Key 时,登录进程仍按原生起 —— 跑一个假 CLI
 *     (真子进程,环境照 worker 起登录的那一种拼法 `composeAgentSpawnEnv`),看它登进了哪个目录、环境里有没有那把 key;
 *  2. 删掉正在用的连接 = 一次切回原生:护栏(有会话在忙就不切)照旧,点「关掉并切换」才删。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { composeAgentSpawnEnv, type AgentRunContext } from '@gugu/session-core/agents/agent-run-context';
import type { AgentConfigRuntimeContract } from '@gugu/session-core/workspace-server';
import type { ContractClient } from '@gugu/session-wire/api';
import { openRegistryFixture, type RegistryFixture } from '@tooling/utils/provider-accounts';

const state = vi.hoisted(() => ({
  fixture: null as RegistryFixture | null,
  home: '',
  userHome: '',
  cli: '',
  busy: false,
  switches: [] as Array<{ providerId: string; connectionId: string; stopBusySessions?: boolean }>,
}));
vi.mock('@main/db/client', () => ({
  get db() {
    return state.fixture!.db;
  },
}));
vi.mock('@main/core/provider-accounts/provider-account-registry-instance', () => ({
  get providerAccountRegistry() {
    return state.fixture!.registry;
  },
}));
vi.mock('electron', () => ({ app: { getPath: () => state.home } }));
vi.mock('@main/lib/logger', () => {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => log };
  return { log };
});
vi.mock('@main/lib/host-ipc', () => ({ getHostIpc: vi.fn() }));
vi.mock('@main/worker-manifest', () => ({ desktopWorkerPath: () => '/unused' }));
vi.mock('@main/utils/systemProxyEnv', () => ({ systemProxyFill: () => ({}) }));
vi.mock('@main/utils/userEnv', () => ({ loginShellEnv: () => ({}) }));
vi.mock('@main/core/dependencies/host-dependency-ledger', () => ({ buildHostDependencyLedgerSnapshot: vi.fn() }));
vi.mock('@main/core/dependencies/dependency-managers', () => ({ ensureAgentDependenciesProbed: vi.fn(), localDependencyManager: {} }));
vi.mock('@main/core/dependencies/host-dependency-store', () => ({ hostDependencyStore: {} }));
// run context 的真算法(`resolveLocalAgentRunContext`)照跑;只把它够到机器的几处换成临时目录里的东西:
// 用户的 shell 环境(HOME 指到临时的用户家)、这一家的 CLI(下面那个假 CLI)、设置里没填东西。
vi.mock('@main/core/pty/pty-env', () => ({
  buildAgentEnv: () => ({ HOME: state.userHome, PATH: process.env.PATH ?? '', CODEX_HOME: join(state.userHome, '.codex') }),
}));
vi.mock('@main/core/agents/agent-home', () => ({ resolveAgentHomeEnv: async () => ({}) }));
vi.mock('@main/core/acp/transport/local-acp-process-host', () => ({ resolveLocalAgentCli: async () => state.cli }));
vi.mock('@main/core/agents/acp-bridge', () => ({ resolveHostAcpAdapterEntry: async () => undefined }));
vi.mock('@main/core/settings/provider-settings-service', () => ({ providerOverrideSettings: { getItem: () => undefined } }));
// 切换本身(停会话、交还)由 subscription-switch.test.ts 管;这里只记它被怎么叫、在忙时照它拒,不忙就真换。
vi.mock('@main/core/sessions/subscription-switch', () => ({
  switchSubscription: vi.fn(
    async (providerId: string, connectionId: string, nativeEnv: Record<string, string | undefined>, options: { stopBusySessions?: boolean } = {}) => {
      state.switches.push({ providerId, connectionId, ...(options.stopBusySessions ? { stopBusySessions: true } : {}) });
      const { SubscriptionSessionsBusyError } = await import('@main/core/sessions/subscription-sessions-busy');
      if (state.busy && !options.stopBusySessions) throw new SubscriptionSessionsBusyError(providerId, 1);
      const { selectHarnessConnection } = await import('@main/core/agents/harness-connections');
      await selectHarnessConnection(providerId, connectionId, { nativeEnv });
    }
  ),
}));

const { withHostResolvedCli } = await import('./host');
const { resolveLocalAgentRunContext } = await import('@main/core/agents/agent-run-context');
const { createHarnessConnection, harnessLoginConnectionId, listHarnessConnections, resolveHarnessConnection } = await import(
  '@main/core/agents/harness-connections'
);

/**
 * 一个假 CLI:`login` 把「登上了」写进**它自己的目录**(`$HOME/.fake-cli`),顺手记下它拿到的整份环境。
 * 读登录态的那一侧(下面的假 worker)看同一个目录 —— 与真 CLI「登录写哪、状态就读哪」同一个关系。
 */
const FAKE_CLI = `
const fs = require('node:fs');
const path = require('node:path');
const own = path.join(process.env.HOME, '.fake-cli');
fs.mkdirSync(own, { recursive: true });
fs.writeFileSync(path.join(own, 'credentials.json'), JSON.stringify({ signedIn: true }));
fs.writeFileSync(path.join(own, 'login-env.json'), JSON.stringify({ env: process.env, argv: process.argv.slice(2) }));
`;

type Started = { input: { providerId: string; connectionId?: string; runContext: AgentRunContext }; env: Record<string, string>; exitCode: number | null };
let started: Started[];
let refreshed: Array<{ providerId: string; connectionId?: string; runContext: AgentRunContext }>;

/** 假 worker:起登录 = 真跑那个 CLI,环境照 worker 的拼法(`buildLoginCommand` 里就是这一句)。 */
const worker = {
  startLogin: async (input: Started['input']) => {
    const env = composeAgentSpawnEnv(input.runContext);
    const cli = input.runContext.cli.kind === 'resolved' ? input.runContext.cli.path : '';
    const run = spawnSync(process.execPath, [cli, 'auth', 'login', ...input.runContext.extraArgs], { env, encoding: 'utf8' });
    started.push({ input, env, exitCode: run.status });
    return { success: true, data: undefined };
  },
  cancelLogin: async () => ({ success: true, data: undefined }),
  // 与 plugin-host 同一条:选中的是 API Key ⇒ 读数就是它;否则看 CLI 自己的目录里登没登上。
  refreshAuthStatus: async (input: { providerId: string; connectionId?: string; runContext: AgentRunContext }) => {
    refreshed.push(input);
    if (input.runContext.apiKeyConnection) return { success: true, data: { kind: 'authenticated', credentialKind: 'api-key' } };
    const home = composeAgentSpawnEnv(input.runContext).HOME;
    const signedIn = existsSync(join(home, '.fake-cli', 'credentials.json'));
    return { success: true, data: signedIn ? { kind: 'authenticated' } : { kind: 'unauthenticated' } };
  },
};
const host = withHostResolvedCli(worker as unknown as ContractClient<AgentConfigRuntimeContract>);

beforeEach(async () => {
  state.home = await mkdtemp(join(tmpdir(), 'gugu-host-connections-'));
  state.userHome = join(state.home, 'user');
  state.cli = join(state.home, 'fake-cli.cjs');
  await writeFile(state.cli, FAKE_CLI);
  state.busy = false;
  state.switches = [];
  started = [];
  refreshed = [];
  state.fixture = await openRegistryFixture('empty');
});
afterEach(async () => {
  state.fixture?.close();
  state.fixture = null;
  await rm(state.home, { recursive: true, force: true });
});

async function selectKey(providerId: string, apiKey: string): Promise<string> {
  const key = await createHarnessConnection({ providerId, kind: 'api-key', apiKey });
  expect(await host.selectConnection({ providerId, connectionId: key.id })).toEqual({ success: true, data: undefined });
  expect((await listHarnessConnections(providerId)).find((connection) => connection.current)?.id).toBe(key.id);
  return key.id;
}

it('a CLI sign-in while an API key is selected signs in the CLI’s own configuration and never sees the key', async () => {
  const keyId = await selectKey('mimocode', 'mimo-secret');
  // 对照:改之前登录按「默认连接」解析 —— 这把 key 就在那份环境里(所以这条测试守得住回退)。
  expect(JSON.stringify(composeAgentSpawnEnv(await resolveLocalAgentRunContext('mimocode', { role: 'primary' })))).toContain('mimo-secret');
  expect(await host.refreshAuthStatus({ providerId: 'mimocode', connectionId: 'native' })).toMatchObject({ data: { kind: 'unauthenticated' } });

  // 界面的「添加连接 → 账号」(登录窗口读 `native` 那一格),以及没带连接的旧界面:两条都按原生起。
  for (const target of [{ connectionId: 'native' }, {}]) {
    started = [];
    expect(await host.startLogin({ providerId: 'mimocode', methodId: 'mimocode-login', ...target })).toEqual({ success: true, data: undefined });
    const [login] = started;
    expect(login.exitCode).toBe(0);
    expect(login.input.connectionId).toBe(target.connectionId);
    expect(login.input.runContext.connectionId).toBeUndefined();
    expect(login.input.runContext.credentialEnv).toBeUndefined();
    expect(login.input.runContext.apiKeyConnection).toBeUndefined();
    expect(JSON.stringify(login.input.runContext)).not.toContain('mimo-secret');
    // 子进程自己记下的那份环境与参数:没有这把 key。
    const seen = JSON.parse(readFileSync(join(state.userHome, '.fake-cli', 'login-env.json'), 'utf8')) as { env: Record<string, string>; argv: string[] };
    expect(JSON.stringify(seen)).not.toContain('mimo-secret');
    expect(seen.env.HOME).toBe(state.userHome);
  }

  // 登进的是 CLI 自己的目录(用户的家),❌ 哪个连接的保管目录。
  expect(existsSync(join(state.userHome, '.fake-cli', 'credentials.json'))).toBe(true);
  expect(existsSync(join(state.home, 'harness-connections'))).toBe(false);
  // 「现有 CLI 配置」这一格登上了;选择没动:当前连接还是那把 key,主读数还是它。
  expect(await host.refreshAuthStatus({ providerId: 'mimocode', connectionId: 'native' })).toMatchObject({ data: { kind: 'authenticated' } });
  expect(await host.refreshAuthStatus({ providerId: 'mimocode' })).toMatchObject({ data: { kind: 'authenticated', credentialKind: 'api-key' } });
  expect((await listHarnessConnections('mimocode')).find((connection) => connection.current)?.id).toBe(keyId);
});

it('Claude / Codex account sign-ins still run on the account connection they name', async () => {
  const work = await createHarnessConnection({ providerId: 'codex', kind: 'account', name: 'Work' });
  expect(harnessLoginConnectionId('codex', work.id)).toBe(work.id);
  expect(harnessLoginConnectionId('claude', undefined)).toBeUndefined();
  // 没有连接的家原样(它的 run context 不看这一格)。
  expect(harnessLoginConnectionId('kiro', undefined)).toBeUndefined();
  await host.startLogin({ providerId: 'codex', methodId: 'codex-login', connectionId: work.id });
  expect(started[0].input.runContext).toMatchObject({
    connectionId: work.id,
    configRootEnv: { CODEX_HOME: join(state.home, 'harness-connections', 'codex', work.id, '.codex') },
  });
});

it('removing the only, current key goes through the switch: refused while a session is busy, then falls back to native', async () => {
  const keyId = await selectKey('mimocode', 'mimo-secret');
  state.switches = [];
  state.busy = true;
  const refused = await host.removeConnection({ providerId: 'mimocode', connectionId: keyId });
  expect(refused).toMatchObject({ success: false, error: { type: 'invalid-state', sessionsBusy: { providerId: 'mimocode', count: 1 } } });
  expect(state.switches).toEqual([{ providerId: 'mimocode', connectionId: 'native' }]);
  // 被拒就什么都没动:它还在、还是当前的。
  expect((await listHarnessConnections('mimocode')).map((connection) => [connection.id, connection.current])).toEqual([
    ['native', false],
    [keyId, true],
  ]);

  // 「关掉并切换」:同一个删除带上 stopBusySessions。
  refreshed = [];
  expect(await host.removeConnection({ providerId: 'mimocode', connectionId: keyId, stopBusySessions: true })).toEqual({ success: true, data: undefined });
  expect(state.switches.at(-1)).toEqual({ providerId: 'mimocode', connectionId: 'native', stopBusySessions: true });
  expect(await listHarnessConnections('mimocode')).toEqual([{ id: 'native', kind: 'native', name: '', current: true, endpoint: undefined }]);
  expect(await resolveHarnessConnection('mimocode', { sessionId: 'any' })).toEqual({});
  // 主读数跟着换回原生(没带连接的那一次读数,run context 里没有 key)。
  expect(refreshed.at(-1)).toMatchObject({ providerId: 'mimocode' });
  expect(refreshed.at(-1)?.connectionId).toBeUndefined();
  expect(refreshed.at(-1)?.runContext.apiKeyConnection).toBeUndefined();
});

it('removing a connection that is not current switches nothing', async () => {
  const keyId = await selectKey('mimocode', 'mimo-secret');
  const other = await createHarnessConnection({ providerId: 'mimocode', kind: 'api-key', apiKey: 'other-secret' });
  state.switches = [];
  state.busy = true;
  expect(await host.removeConnection({ providerId: 'mimocode', connectionId: other.id })).toEqual({ success: true, data: undefined });
  expect(state.switches).toEqual([]);
  expect((await listHarnessConnections('mimocode')).map((connection) => connection.id)).toEqual(['native', keyId]);
  // 原生那一份删不掉,也不会为它先切一次。
  expect(await host.removeConnection({ providerId: 'mimocode', connectionId: 'native' })).toMatchObject({ success: false });
  expect(state.switches).toEqual([]);
});

it('the model list is read by the host (the key goes only to the address) and models change in place', async () => {
  const { createServer } = await import('node:http');
  const seen: Array<string | undefined> = [];
  const relay = createServer((req, res) => {
    seen.push(req.headers.authorization);
    res.writeHead(req.url === '/v1/models' ? 200 : 404, { 'content-type': 'application/json' });
    res.end(JSON.stringify(req.url === '/v1/models' ? { data: [{ id: 'm-2' }, { id: 'm-1' }] } : {}));
  });
  await new Promise<void>((resolve) => relay.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${(relay.address() as { port: number }).port}/v1`;
  try {
    expect(await host.listConnectionModels({ providerId: 'qwen', apiKey: 'qwen-secret', endpoint })).toEqual({
      success: true,
      data: { kind: 'listed', models: ['m-1', 'm-2'] },
    });
    expect(seen).toEqual(['Bearer qwen-secret']);
    const created = await createHarnessConnection({ providerId: 'qwen', kind: 'api-key', apiKey: 'qwen-secret', endpoint, models: ['m-1'] });
    expect(await host.updateConnectionModels({ providerId: 'qwen', connectionId: created.id, models: ['m-1', 'm-2'] })).toMatchObject({
      success: true,
      data: { id: created.id, models: ['m-1', 'm-2'] },
    });
    // 不点名模型的家没有这一格:答一条失败,❌ 抛出去。
    expect(await host.listConnectionModels({ providerId: 'mimocode', apiKey: 'k' })).toMatchObject({ success: false });
  } finally {
    await new Promise((resolve) => relay.close(resolve));
  }
});
