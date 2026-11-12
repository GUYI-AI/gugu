/**
 * #2507 mac1 实机:Codex 选着一把 API Key,聊天(ACP)腿每一轮都是「Missing bearer or basic authentication in header」。
 * 进程里有 OPENAI_API_KEY,可 codex 内置的 openai provider 不读它 —— 要靠连接给的 `-c model_provider=gugu_connection
 * … env_key=OPENAI_API_KEY`,而这几个参数只并进了终端腿的 `extraArgs`,聊天腿起适配器时一个都没递。
 *
 * 这里从头走到尾:真的连接表 → 主进程真的 run context 解析(`resolveLocalAgentRunContext`)→ worker 真的
 * `AgentPluginHost.buildAcpSpawn` 与真的 codex / claude 插件,看适配器拿到的 argv 与环境。
 */
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AgentPluginHost, createPluginRegistry, type CLIAgentPluginProvider } from '@gugu/session-core/agents/plugins';
import { createLocalPluginFs } from '@gugu/session-core/agents/plugins/helpers';
import { NodeExecutionContext } from '@gugu/session-core/exec';
import { pluginRegistry } from '@gugu/session-plugins/agents';
import { noopLogger } from '@gugu/session-shared/logger';
import { createScope } from '@gugu/session-wire/util';
import { openRegistryFixture, type RegistryFixture } from '@tooling/utils/provider-accounts';

const state = vi.hoisted(() => ({ fixture: null as RegistryFixture | null, home: '', userHome: '', clis: {} as Record<string, string> }));
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
vi.mock('@main/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
// 够到机器的几处换成临时目录里的东西:用户的 shell 环境、这一家的 CLI(会报版本的假程序)、桥入口、设置。
vi.mock('@main/core/pty/pty-env', () => ({
  buildAgentEnv: () => ({
    HOME: state.userHome,
    PATH: process.env.PATH ?? '',
    CODEX_HOME: join(state.userHome, '.codex'),
    CLAUDE_CONFIG_DIR: join(state.userHome, '.claude'),
  }),
}));
vi.mock('@main/core/agents/agent-home', () => ({ resolveAgentHomeEnv: async () => ({}) }));
vi.mock('@main/core/acp/transport/local-acp-process-host', () => ({ resolveLocalAgentCli: async (providerId: string) => state.clis[providerId] }));
vi.mock('@main/core/agents/acp-bridge', () => ({ resolveHostAcpAdapterEntry: async (providerId: string) => `/bridge/${providerId}-acp.mjs` }));
vi.mock('@main/core/settings/provider-settings-service', () => ({ providerOverrideSettings: { getItem: () => undefined } }));

const { resolveLocalAgentRunContext } = await import('./agent-run-context');
const { createHarnessConnection, selectHarnessConnection } = await import('./harness-connections');

const PLATFORM = {
  providerId: 'gugu_platform',
  providerLabel: 'Gugu',
  baseUrl: 'http://127.0.0.1:1/relay/v1',
  model: 'gpt-5.6-luna',
  apiKey: 'platform-token',
  spawnEnv: {},
};

let scope: ReturnType<typeof createScope>;
let host: AgentPluginHost;

beforeEach(async () => {
  state.home = await mkdtemp(join(tmpdir(), 'gugu-connection-acp-'));
  state.userHome = join(state.home, 'user');
  // 版本探针真跑:一个只会报版本的假 CLI,版本高于这一家聊天腿的下界。
  for (const [id, version] of [['codex', 'codex-cli 0.999.0'], ['claude', '9.9.9 (Claude Code)']] as const) {
    const path = join(state.home, id);
    await writeFile(path, `#!/bin/sh\necho "${version}"\n`);
    await chmod(path, 0o755);
    state.clis[id] = path;
  }
  state.fixture = await openRegistryFixture('empty');
  scope = createScope({ label: 'connection-acp-spawn', logger: noopLogger });
  const registry = createPluginRegistry<CLIAgentPluginProvider>();
  for (const id of ['codex', 'claude']) registry.register(pluginRegistry.get(id)!);
  host = new AgentPluginHost({
    scope,
    registry,
    fs: createLocalPluginFs(state.userHome),
    homeDir: state.userHome,
    exec: new NodeExecutionContext({ env: { PATH: process.env.PATH ?? '' } }),
  });
});
afterEach(async () => {
  await scope.dispose();
  state.fixture?.close();
  state.fixture = null;
  await rm(state.home, { recursive: true, force: true });
});

/** 聊天会话起适配器 —— 与 worker 同一条:宿主算 run context(role acp,按会话),worker 拿它起。 */
async function acpSpawn(providerId: string, platform?: typeof PLATFORM) {
  const runContext = await resolveLocalAgentRunContext(providerId, { role: 'acp', sessionId: 'session-1' });
  const spawn = await host.buildAcpSpawn(providerId, { cwd: state.home, runContext, ...(platform ? { platform } : {}) });
  if (!spawn.success) throw new Error(JSON.stringify(spawn.error));
  return spawn.data;
}

const providerArgs = (args: readonly string[]) => args.filter((arg) => arg.startsWith('model_provider='));

it('a selected Codex API key reaches the chat adapter as its own provider, with the key in OPENAI_API_KEY', async () => {
  const key = await createHarnessConnection({ providerId: 'codex', kind: 'api-key', apiKey: 'codex-secret' });
  await selectHarnessConnection('codex', key.id);
  const spawn = await acpSpawn('codex');
  // 适配器把自己 argv 原样转给 `codex app-server`(codex-app-server-acp.mjs 的 inheritedArgs)。
  expect(providerArgs(spawn.args)).toEqual(['model_provider="gugu_connection"']);
  expect(spawn.args).toContain('model_providers.gugu_connection.env_key="OPENAI_API_KEY"');
  expect(spawn.args).toContain('model_providers.gugu_connection.base_url="https://api.openai.com/v1"');
  expect(spawn.env?.OPENAI_API_KEY).toBe('codex-secret');
  // key 只在环境里,❌ 上 argv(进程表人人可读)。
  expect(JSON.stringify(spawn.args)).not.toContain('codex-secret');
});

it('a Gugu platform model still wins over the selected key: its provider only, its token in OPENAI_API_KEY', async () => {
  const key = await createHarnessConnection({ providerId: 'codex', kind: 'api-key', apiKey: 'codex-secret' });
  await selectHarnessConnection('codex', key.id);
  const spawn = await acpSpawn('codex', PLATFORM);
  expect(providerArgs(spawn.args)).toEqual(['model_provider=gugu_platform']);
  expect(JSON.stringify(spawn.args)).not.toContain('gugu_connection');
  expect(spawn.env?.OPENAI_API_KEY).toBe('platform-token');
});

it('the native configuration and an account connection add no provider (codex uses its own sign-in)', async () => {
  expect(providerArgs((await acpSpawn('codex')).args)).toEqual([]);
  const account = await createHarnessConnection({ providerId: 'codex', kind: 'account', name: 'Work' });
  // 账号连接 = 把它的凭据换进用户根(这里只看 argv):不加 provider。
  expect((await resolveLocalAgentRunContext('codex', { role: 'acp', connectionId: account.id })).connectionArgs).toBeUndefined();
});

it('a selected Claude API key reaches the chat adapter through its environment only', async () => {
  const key = await createHarnessConnection({ providerId: 'claude', kind: 'api-key', apiKey: 'claude-secret' });
  await selectHarnessConnection('claude', key.id);
  const spawn = await acpSpawn('claude');
  expect(spawn.env?.ANTHROPIC_API_KEY).toBe('claude-secret');
  expect(JSON.stringify(spawn.args)).not.toContain('claude-secret');
});
