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
import { AgentPluginHost, createPluginRegistry, type CLIAgentPluginProvider, type LiveSettingsCapability } from '@gugu/session-core/agents/plugins';
import { AcpRuntime } from '@gugu/session-runtime/acp-agents';
import { createLocalPluginFs } from '@gugu/session-core/agents/plugins/helpers';
import { NodeExecutionContext } from '@gugu/session-core/exec';
import { pluginRegistry } from '@gugu/session-plugins/agents';
import { noopLogger } from '@gugu/session-shared/logger';
import { createScope } from '@gugu/session-wire/util';
import { openRegistryFixture, type RegistryFixture } from '@tooling/utils/provider-accounts';
import { makeAcpHarness, makeStartInput, testPluginHost } from '../../../../../../../packages/session-runtime/src/acp-agents/acp-test-support';

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

// #2507 第 7 轮:key 走环境变量的家,新建任务菜单列出连接勾选的全部模型(`currentConnectionMenuModels`);会话选了哪个,
// 主进程给这条会话算的 run context(聊天腿与终端腿同一个)里就是哪个 —— 它们的 launch 一次只吃一个模型。
it.each(['qwen', 'copilot', 'zcode', 'hermes', 'antigravity'])(
  '%s: the menu lists every model the key names, and the session runs the one it picked',
  async (providerId) => {
    const { currentConnectionMenuModels } = await import('./harness-connections');
    state.fixture!.sqlite.exec(`INSERT OR IGNORE INTO projects (id, name, path) VALUES ('project', 'Project', '/repo');
      INSERT INTO sessions (id, project_id, provider, runtime, config)
      VALUES ('picked-second', 'project', '${providerId}', 'acp', '{"version":"1","type":"acp","model":"model-two"}');`);
    expect(await currentConnectionMenuModels(providerId)).toBeNull();
    const key = await createHarnessConnection({
      providerId,
      kind: 'api-key',
      apiKey: `${providerId}-secret`,
      endpoint: 'https://relay.example/v1',
      models: ['model-one', 'model-two'],
    });
    await selectHarnessConnection(providerId, key.id);
    expect(await currentConnectionMenuModels(providerId)).toEqual(['model-one', 'model-two']);

    const launched = (context: Awaited<ReturnType<typeof resolveLocalAgentRunContext>>) =>
      JSON.stringify({ env: context.credentialEnv, args: context.extraArgs });
    for (const role of ['acp', 'tui'] as const) {
      const picked = launched(await resolveLocalAgentRunContext(providerId, { role, sessionId: 'picked-second' }));
      expect(picked, role).toContain('model-two');
      expect(picked, role).not.toContain('model-one');
      expect(picked, role).toContain(`${providerId}-secret`);
    }
    // 没有会话(模型目录探针、登录态):第一个。
    const probe = launched(await resolveLocalAgentRunContext(providerId, { role: 'acp' }));
    expect(probe).toContain('model-one');
    expect(probe).not.toContain('model-two');
  }
);

// #2507 第 8 轮(mac1 实机):Qwen 选着 API Key 连接,新建任务里挑了 gpt-4.1-mini —— 进程按环境跑的就是它,可每条会话都报
// 「建这个任务时的模型这里用不了,改跑 $runtime|openai|gpt-4.1-mini(openai)」:运行时拿记录里的模型名去 set_config,
// 而 qwen 自己的 id 是 `$runtime|openai|<名>(openai)`,名字被拒(`Model 'gpt-4.1-mini' not found for authType 'openai'`)。
// 这里从头走:真的连接表 → 主进程真的 run context → 真的 AcpRuntime(这一家真的实时设置声明)→ 一个照 qwen 写法报 id、
// 跑环境点名的那个模型、拒收裸名字的假 ACP agent。新开与续接两条路都不该去设模型,也不该有「模型不可用」。
it.each(['qwen', 'copilot', 'zcode', 'hermes', 'antigravity'])(
  '%s: a session on the model its key names through the environment starts on it with no model notice',
  async (providerId) => {
    state.fixture!.sqlite.exec(`INSERT OR IGNORE INTO projects (id, name, path) VALUES ('project', 'Project', '/repo');
      INSERT INTO sessions (id, project_id, provider, runtime, config)
      VALUES ('env-picked', 'project', '${providerId}', 'acp', '{"version":"1","type":"acp","model":"model-two"}');`);
    const key = await createHarnessConnection({
      providerId,
      kind: 'api-key',
      apiKey: `${providerId}-secret`,
      endpoint: 'https://relay.example/v1',
      models: ['model-one', 'model-two'],
    });
    await selectHarnessConnection(providerId, key.id);
    const runContext = await resolveLocalAgentRunContext(providerId, { role: 'acp', sessionId: 'env-picked' });
    expect(runContext.apiKeyConnection?.model).toBe('model-two');

    for (const providerSessionId of [null, 'provider-session']) {
      const h = makeAcpHarness({ providerId });
      let spawnEnv: Record<string, string> = {};
      // 这一家真的实时设置声明(qwen:reload-session;其余:acp-config-option),桥起进程时拿到的是宿主合成的那份环境。
      h.deps.agentHost = testPluginHostFor(providerId, {
        buildSpawn: (ctx) => {
          spawnEnv = { ...ctx.env };
          return { command: '/fake/node', args: ['agent.js'], env: {} };
        },
        connect: h.agent.behavior.connect,
      });
      // 假 agent:跑环境点名的那个模型,照 qwen 的写法报 id;拿别的值来设模型一律拒(qwen 0.22.3 的原话)。
      const running = () => ['model-one', 'model-two'].filter((name) => JSON.stringify(spawnEnv).includes(name));
      const configOptions = () => {
        const [name] = running();
        const id = `$runtime|openai|${name}(openai)`;
        return [{
          id: 'model', name: 'Model', category: 'model' as const, type: 'select' as const, currentValue: id,
          options: [{ value: id, name: id }, { value: 'coder-model(qwen-oauth)', name: 'coder-model' }],
        }];
      };
      h.agent.newSession.mockImplementation(async () => ({ sessionId: 'provider-session', configOptions: configOptions() }));
      h.agent.loadSession.mockImplementation(async () => ({ configOptions: configOptions() }));
      h.agent.setSessionConfigOption.mockImplementation(async ({ configId, value }: { configId: string; value: string }) => {
        if (configId === 'model' && !configOptions()[0]!.options.some((option) => option.value === value)) {
          throw new Error(`Model '${value}' not found for authType 'openai'`);
        }
        return { configOptions: configOptions() };
      });
      const runtime = new AcpRuntime(h.deps);
      try {
        const start = await runtime.startSession(makeStartInput({
          sessionId: 'env-picked',
          providerId,
          providerSessionId,
          // 宿主交给运行时的「自己的模型」= 会话记录里那个(host.ts `readSessionInjectionFacts`)。
          model: 'model-two',
          runContext: { ...runContext, cli: { kind: 'resolved', path: '/usr/local/bin/fake-agent' } },
        }));
        expect(start.success, `${providerSessionId}: ${JSON.stringify(start)}`).toBe(true);
        expect(running(), 'the process runs the picked model').toEqual(['model-two']);
        const modelSets = h.agent.setSessionConfigOption.mock.calls.filter(([params]) => params.configId === 'model');
        expect(modelSets, `${providerSessionId}`).toEqual([]);
        const history = JSON.stringify(runtime.getChatHistory('env-picked'));
        expect(history).not.toContain('model-unavailable');
        expect(history).not.toContain('$runtime|openai|');
        await runtime.sendPrompt('env-picked', { text: 'hello', origin: 'typed' });
        expect(h.agent.prompt).toHaveBeenCalledOnce();
      } finally {
        await runtime.dispose();
      }
    }
  }
);

/** 只取这一家真的实时设置声明(启动时设不设模型看的就是它);其余照测试宿主,桥换成会记下环境的假进程。 */
function testPluginHostFor(providerId: string, acpBehavior: { buildSpawn: (ctx: { env: Record<string, string> }) => { command: string; args: string[]; env: Record<string, string> }; connect: unknown }) {
  const declared = pluginRegistry.get(providerId)!.capabilities.acp as { liveSettings?: LiveSettingsCapability };
  expect(declared.liveSettings?.model, providerId).toBeDefined();
  return testPluginHost({ providerId, liveSettings: declared.liveSettings, acpBehavior: acpBehavior as never });
}
