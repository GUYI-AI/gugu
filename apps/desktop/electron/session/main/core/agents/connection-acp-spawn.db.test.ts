import { releaseCustomModelForwarders } from './custom-model-forwarder';
import { customModelOptionId } from '@gugu/session-core/models/custom-model';
/**
 * #2507 mac1 实机:Codex 选着一把 API Key,聊天(ACP)腿每一轮都是「Missing bearer or basic authentication in header」。
 * 进程里有 OPENAI_API_KEY,可 codex 内置的 openai provider 不读它 —— 要靠连接给的 `-c model_provider=gugu_connection
 * … env_key=OPENAI_API_KEY`,而这几个参数只并进了终端腿的 `extraArgs`,聊天腿起适配器时一个都没递。
 *
 * 这里从头走到尾:真的连接表 → 主进程真的 run context 解析(`resolveLocalAgentRunContext`)→ worker 真的
 * `AgentPluginHost.buildAcpSpawn` 与真的 codex / claude 插件,看适配器拿到的 argv 与环境。
 */
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
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

const { appSettingsService } = await import('../settings/settings-service');
const { resolveLocalAgentRunContext } = await import('./agent-run-context');
const { createHarnessConnection } = await import('./harness-connections');
const { saveCustomModel, resolveCustomModelLaunch } = await import('./custom-models');
const { connectionModelLaunch } = await import('../../../../sessionpage/connection-model-launch');
const { claudeCustomModelSessionMeta } = await import('./custom-model-run-context');
const { trustedPlatformInputPatch } = await import('../acp/runtime-process/session-meta');

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
  vi.stubEnv('GUGU_HOME', join(state.home, 'gugu-home'));
  // 版本探针真跑:一个只会报版本的假 CLI,版本高于这一家聊天腿的下界。
  for (const [id, version] of [['codex', 'codex-cli 0.999.0'], ['claude', '9.9.9 (Claude Code)'], ['opencode', '1.999.0']] as const) {
    const path = join(state.home, id);
    await writeFile(path, `#!/bin/sh\necho "${version}"\n`);
    await chmod(path, 0o755);
    state.clis[id] = path;
  }
  state.fixture = await openRegistryFixture('empty');
  scope = createScope({ label: 'connection-acp-spawn', logger: noopLogger });
  const registry = createPluginRegistry<CLIAgentPluginProvider>();
  for (const id of ['codex', 'claude', 'opencode']) registry.register(pluginRegistry.get(id)!);
  host = new AgentPluginHost({
    scope,
    registry,
    fs: createLocalPluginFs(state.userHome),
    homeDir: state.userHome,
    exec: new NodeExecutionContext({ env: { PATH: process.env.PATH ?? '' } }),
  });
});
afterEach(async () => {
  await appSettingsService.reset('autoReviewModel');
  vi.unstubAllEnvs();
  releaseCustomModelForwarders();
  await scope.dispose();
  state.fixture?.close();
  state.fixture = null;
  await rm(state.home, { recursive: true, force: true });
});

/** 聊天会话起适配器 —— 与 worker 同一条:宿主算 run context(role acp,按会话),worker 拿它起。 */
async function acpSpawn(providerId: string, platform?: typeof PLATFORM) {
  if (platform) state.fixture!.sqlite.prepare('UPDATE sessions SET config = ? WHERE id = ?').run(JSON.stringify({ version: '1', type: 'acp' }), 'session-1');
  const runContext = await resolveLocalAgentRunContext(providerId, { role: 'acp', sessionId: 'session-1' });
  const custom = await resolveCustomModelLaunch(providerId, 'session-1');
  const launch = custom && connectionModelLaunch({ providerId, surface: 'cui', ...custom });
  const spawn = await host.buildAcpSpawn(providerId, {
    cwd: state.home, runContext, ...(platform ? { platform } : {}),
    ...(launch ? { capabilitySpawnEnv: launch.spawnEnv, capabilitySpawnArgs: launch.adapterArgs } : {}),
  });
  if (!spawn.success) throw new Error(JSON.stringify(spawn.error));
  return spawn.data;
}

const providerArgs = (args: readonly string[]) => args.filter((arg) => arg.startsWith('model_provider='));

it('a selected Codex API key reaches the chat adapter as its own provider, with the key in OPENAI_API_KEY', async () => {
  const key = await saveCustomModel({ name: 'Provider', apiKey: 'codex-secret', preset: null, endpoints: [{ protocol: 'openai-responses', baseUrl: 'https://api.openai.com/v1' }], models: [{ id: 'model-two' }] });
  state.fixture!.sqlite.exec("INSERT OR IGNORE INTO projects (id,name,path) VALUES ('project','Project','/repo')");
  state.fixture!.sqlite.prepare('INSERT INTO sessions (id,project_id,provider,runtime,config) VALUES (?,?,?,?,?)').run('session-1', 'project', 'codex', 'acp', JSON.stringify({ version: '1', type: 'acp', model: customModelOptionId({ connectionId: key.id, modelId: 'model-two' }) }));
  const spawn = await acpSpawn('codex');
  // 适配器把自己 argv 原样转给 `codex app-server`(codex-app-server-acp.mjs 的 inheritedArgs)。
  expect(providerArgs(spawn.args)).toEqual(['model_provider="gugu_connection"']);
  expect(spawn.args).toContain('model_providers.gugu_connection.env_key="OPENAI_API_KEY"');
  expect(spawn.args.some((arg) => arg.startsWith('model_providers.gugu_connection.base_url="http://127.0.0.1:'))).toBe(true);
  expect(spawn.env?.OPENAI_API_KEY).toMatch(/^sk-gugu-/);
  // key 只在环境里,❌ 上 argv(进程表人人可读)。
  expect(spawn.args).toContain('model="model-two"');
  expect(JSON.stringify(spawn)).not.toMatch(/codex-secret|custom:/);
});

it('a Gugu platform model still wins over the selected key: its provider only, its token in OPENAI_API_KEY', async () => {
  const key = await saveCustomModel({ name: 'Provider', apiKey: 'codex-secret', preset: null, endpoints: [{ protocol: 'openai-responses', baseUrl: 'https://api.openai.com/v1' }], models: [{ id: 'model-two' }] });
  state.fixture!.sqlite.exec("INSERT OR IGNORE INTO projects (id,name,path) VALUES ('project','Project','/repo')");
  state.fixture!.sqlite.prepare('INSERT INTO sessions (id,project_id,provider,runtime,config) VALUES (?,?,?,?,?)').run('session-1', 'project', 'codex', 'acp', JSON.stringify({ version: '1', type: 'acp', model: customModelOptionId({ connectionId: key.id, modelId: 'model-two' }) }));
  const spawn = await acpSpawn('codex', PLATFORM);
  expect(providerArgs(spawn.args)).toEqual(['model_provider=gugu_platform']);
  expect(JSON.stringify(spawn.args)).not.toContain('gugu_connection');
  expect(spawn.env?.OPENAI_API_KEY).toBe('platform-token');
});

it('the native configuration and an account connection add no provider (codex uses its own sign-in)', async () => {
  expect(providerArgs((await acpSpawn('codex')).args)).toEqual([]);
  const account = await createHarnessConnection({ providerId: 'codex', kind: 'account', name: 'Work' });
  // An account connection moves its sign-in into the managed root without adding a provider.
  expect((await resolveLocalAgentRunContext('codex', { role: 'acp', connectionId: account.id })).connectionArgs).toBeUndefined();
});

it('Claude keeps its ACP options and receives the selected upstream model through a protected settings file', async () => {
  const key = await saveCustomModel({ name: 'Provider', apiKey: 'claude-secret', preset: null, endpoints: [{ protocol: 'anthropic-messages', baseUrl: 'https://api.anthropic.com' }], models: [{ id: 'model-two' }] });
  state.fixture!.sqlite.exec("INSERT OR IGNORE INTO projects (id,name,path) VALUES ('project','Project','/repo')");
  state.fixture!.sqlite.prepare('INSERT INTO sessions (id,project_id,provider,runtime,config) VALUES (?,?,?,?,?)').run('session-1', 'project', 'claude', 'acp', JSON.stringify({ version: '1', type: 'acp', model: customModelOptionId({ connectionId: key.id, modelId: 'model-two' }) }));
  const spawn = await acpSpawn('claude');
  expect(spawn.env?.ANTHROPIC_AUTH_TOKEN).toMatch(/^sk-gugu-/);
  expect(spawn.env?.ANTHROPIC_MODEL).toBe('model-two');
  expect(JSON.stringify(spawn)).not.toMatch(/claude-secret|custom:/);
  expect(spawn.args).not.toContain('--settings');
  const sessionMeta = (await claudeCustomModelSessionMeta('session-1'))!;
  const settings = sessionMeta.claudeCode.options.settings!;
  const baseline = {
    env: { CLAUDE_CONFIG_DIR: '/kept-config' },
    allowedTools: ['mcp__gugu__read'],
    disallowedTools: ['Write'],
    persistSession: false,
    plugins: [{ type: 'local', path: '/plugin' }],
  };
  expect(trustedPlatformInputPatch({ kind: 'session-meta', sessionMeta }, {
    sessionMeta: { claudeCode: { options: baseline } },
  })).toEqual({
    sessionMeta: { claudeCode: { options: { ...baseline, settings, model: 'model-two' } } },
  });
  try {
    if (process.platform !== 'win32') expect((await stat(settings)).mode & 0o777).toBe(0o600);
    const document = await readFile(settings, 'utf8');
    expect(document).not.toMatch(/claude-secret|custom:/);
    expect(JSON.parse(document).env).toMatchObject({ ANTHROPIC_MODEL: 'model-two' });
    const terminal = await resolveLocalAgentRunContext('claude', { role: 'tui', sessionId: 'session-1' });
    expect(terminal.extraArgs).toEqual(['--settings', settings]);
    expect(terminal.extraArgs.join(' ')).not.toContain('sk-gugu-');
  } finally {
    await rm(settings, { force: true });
  }
});

it('the OpenCode writer and process receive the upstream model ID from the stored selection', async () => {
  const modelId = 'family:model';
  const connection = await saveCustomModel({
    name: 'Provider', apiKey: 'opencode-secret', preset: null,
    endpoints: [{ protocol: 'openai-responses', baseUrl: 'https://provider.test/v1' }],
    models: [{ id: modelId }],
  });
  state.fixture!.sqlite.exec("INSERT INTO projects (id,name,path) VALUES ('project','Project','/repo')");
  state.fixture!.sqlite.prepare('INSERT INTO sessions (id,project_id,provider,runtime,config) VALUES (?,?,?,?,?)')
    .run('session-1', 'project', 'opencode', 'acp', JSON.stringify({
      version: '1', type: 'acp', model: customModelOptionId({ connectionId: connection.id, modelId }),
    }));
  const spawn = await acpSpawn('opencode');
  const config = JSON.parse(spawn.env!.OPENCODE_CONFIG_CONTENT!);
  expect(config.model).toBe(`api-key-connection/${modelId}`);
  expect(config.provider['api-key-connection'].models).toHaveProperty([modelId]);
  expect(JSON.stringify(spawn)).not.toMatch(/opencode-secret|custom:/);
});

it.each(['default', 'same', 'other', 'deleted'] as const)('delivers the global reviewer through the same API connection (%s)', async selection => {
  const connection = await saveCustomModel({ name: 'Compatible', apiKey: 'fixture-upstream-key', preset: null,
    endpoints: [{ protocol: 'anthropic-messages', baseUrl: 'https://compatible.example/v1' }],
    models: [{ id: 'claude-opus-5' }, { id: 'reviewer-v1' }],
  });
  if (selection !== 'default') await appSettingsService.update('autoReviewModel', {
    kind: 'custom', connectionId: selection === 'other' ? '00000000-0000-4000-8000-000000000001' : connection.id,
    modelId: selection === 'deleted' ? 'no-longer-listed' : 'reviewer-v1',
  });
  state.fixture!.sqlite.exec("INSERT INTO projects (id,name,path) VALUES ('project','Project','/repo')");
  state.fixture!.sqlite.prepare('INSERT INTO sessions (id,project_id,provider,runtime,config) VALUES (?,?,?,?,?)')
    .run('session-1', 'project', 'claude', 'acp', JSON.stringify({ version: '1', type: 'acp', model: customModelOptionId({ connectionId: connection.id, modelId: 'claude-opus-5' }) }));
  const reviewer = selection === 'same' ? 'reviewer-v1' : 'claude-opus-5';
  const spawn = await acpSpawn('claude');
  expect(spawn.env.CLAUDE_CODE_AUTO_MODE_MODEL).toBe(reviewer);
  expect(spawn.env.ANTHROPIC_MODEL).toBe('claude-opus-5');
  expect(spawn.autoReviewAllowed).toBe(true);
  const meta = (await claudeCustomModelSessionMeta('session-1'))!;
  const settings = JSON.parse(await readFile(meta.claudeCode.options.settings!, 'utf8'));
  expect(settings.env.CLAUDE_CODE_AUTO_MODE_MODEL).toBe(reviewer);
  expect(settings.env.ANTHROPIC_MODEL).toBe('claude-opus-5');
  expect(settings.env.ANTHROPIC_BASE_URL).toContain(`/r/${connection.id}/`);
  expect(JSON.stringify(spawn)).not.toContain('fixture-upstream-key');
});

it('carries the missing-main-model review veto through the host spawn contract', async () => {
  const connection = await saveCustomModel({ name: 'Default-only compatible', apiKey: 'fixture-upstream-key', preset: null,
    endpoints: [{ protocol: 'anthropic-messages', baseUrl: 'https://compatible.example/v1' }], models: [],
  });
  state.fixture!.sqlite.exec("INSERT INTO projects (id,name,path) VALUES ('project','Project','/repo')");
  state.fixture!.sqlite.prepare('INSERT INTO sessions (id,project_id,provider,runtime,config) VALUES (?,?,?,?,?)')
    .run('session-1', 'project', 'claude', 'acp', JSON.stringify({ version: '1', type: 'acp', model: customModelOptionId({ connectionId: connection.id }) }));
  const spawn = await acpSpawn('claude');
  expect(spawn.autoReviewAllowed).toBe(false);
  expect(spawn.env.CLAUDE_CODE_AUTO_MODE_MODEL).toBeUndefined();
});
