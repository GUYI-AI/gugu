/**
 * #2507 终端(TUI)腿:Codex 的推理跑在一台 `codex app-server` 里,它的 argv = 物化器给的那段(平台额度的会话含
 * 平台的 provider)+ 运行上下文的那段(用户填的额外参数,接着所选连接的 provider)。codex 的 `-c` 按 argv 顺序
 * 后者盖前者(openai/codex `codex-rs/config/src/overrides.rs` `build_cli_overrides_layer`)。
 *
 * 从头走到尾:真的连接表 → 主进程真的 run context 解析(`resolveLocalAgentRunContext`)→ 真的 codex 物化器(平台声明
 * 用真的 `withPlatformDeclaration` 嫁接,与 `session-tui-host-start.ts` 的 `startCodexAppServer` 同一个函数)→ 真的
 * `provisionAndOverride` 组 app-server 的启动参数与环境。只有起进程那一下换成记下参数的假会话。
 */
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { runContextLaunchArgs, type AgentRunContext } from '@gugu/session-core/agents/agent-run-context';
import { openRegistryFixture, type RegistryFixture } from '@tooling/utils/provider-accounts';

const state = vi.hoisted(() => ({
  fixture: null as RegistryFixture | null,
  home: '',
  userHome: '',
  codexCli: '',
  settings: undefined as { extraArgs?: string } | undefined,
  started: [] as Array<{ extraArgs: string[]; env: Record<string, string> }>,
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
vi.mock('@main/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
// 够到机器的几处换成临时目录里的东西:用户的 shell 环境、codex(会报版本的假程序)、桥入口、设置。
vi.mock('@main/core/pty/pty-env', () => ({
  buildAgentEnv: () => ({ HOME: state.userHome, PATH: process.env.PATH ?? '', CODEX_HOME: join(state.userHome, '.codex') }),
}));
vi.mock('@main/core/agents/agent-home', () => ({ resolveAgentHomeEnv: async () => ({}) }));
vi.mock('@main/core/acp/transport/local-acp-process-host', () => ({ resolveLocalAgentCli: async () => state.codexCli }));
vi.mock('@main/core/agents/acp-bridge', () => ({ resolveHostAcpAdapterEntry: async () => undefined }));
vi.mock('@main/core/settings/provider-settings-service', () => ({ providerOverrideSettings: { getItem: () => state.settings } }));
vi.mock('@gugu/core/cloud/agentIdentityReconcile', () => ({}));
// 身份供给与投递认领不是这里问的事。
vi.mock('../../../../sessionpage/emdash-agent-provisioning', () => ({
  provisionSessionpageAgentForSession: vi.fn(async (input: { sessionId: string }) => ({
    guguAgentUserId: `agent-${input.sessionId}`,
    chatId: null,
    event: { sessionId: input.sessionId, agentUserId: `agent-${input.sessionId}`, displayName: 'Codex 1', chatId: null },
  })),
  emitSessionpageAgentProvisioned: vi.fn(),
}));
vi.mock('../../../../sessionpage/emdash-agent-registry', () => ({
  registerEmdashAgent: vi.fn(),
  unregisterEmdashAgent: vi.fn(),
  emdashAgentRegistry: {
    deliveryTargetName: 'gugu-acp',
    liveSessionIdByAgent: () => null,
    releaseAgentClaim: () => {},
    unregisterAgent: (_id: string, onReleased?: () => void) => onReleased?.(),
  },
}));
vi.mock('../../../../sessionpage/local-session-delivery', () => ({
  registerOfflineLocalSessionDelivery: vi.fn(),
  unregisterLocalSessionDeliveryForAgent: vi.fn(),
  localSessionDeliveryTarget: { deliveryTargetName: 'local-session-pty', liveSessionIdByAgent: () => null },
}));
// 起 app-server 那一下:记下它拿到的 argv 与环境。
vi.mock('../../../../sessionpage/codex-app-server-delivery', () => {
  class FakeCodexAppServerSession {
    threadId: string | null = null;
    async start(_cwd: string, opts: { extraArgs?: string[]; env?: Record<string, string> }) {
      state.started.push({ extraArgs: opts.extraArgs ?? [], env: opts.env ?? {} });
      return null;
    }
    async waitForTuiThread() {
      this.threadId = 'thread-1';
      return this.threadId;
    }
    isAwaitingTuiThread() {
      return false;
    }
    isLive() {
      return true;
    }
    remoteTuiArgs() {
      return ['--remote', 'unix:///tmp/x.sock'];
    }
    dispose() {}
  }
  return {
    CodexAppServerSession: FakeCodexAppServerSession,
    CodexSessionClosedError: class extends Error {},
    codexAppServerRegistry: { register: vi.fn(), unregister: vi.fn(async () => {}), tryInjectMessage: vi.fn() },
  };
});

const { createHarnessConnection, selectHarnessConnection } = await import('./harness-connections');
const { provisionAndOverride } = await import('../../../../sessionpage/codex-pty-provisioning');
const { withPlatformDeclaration } = await import('../../../../sessionpage/sessionpage-platform-model');
const { loadCodexAppServerCapabilities, PRODUCT_CAPABILITY_PACKAGES } = await import('../../../../capability-bundle');
type ModelCapability = Parameters<typeof withPlatformDeclaration>[0];

/** 这条会话签下的平台额度(中转地址 + 令牌)。 */
const PLATFORM = { platformProvider: { baseUrl: 'http://127.0.0.1:1/relay/v1', apiKey: 'platform-token' }, contextWindow: null };

beforeEach(async () => {
  state.home = await mkdtemp(join(tmpdir(), 'gugu-connection-tui-'));
  state.userHome = join(state.home, 'user');
  state.codexCli = join(state.home, 'codex');
  await writeFile(state.codexCli, '#!/bin/sh\necho "codex-cli 0.999.0"\n');
  await chmod(state.codexCli, 0o755);
  state.fixture = await openRegistryFixture('empty');
  state.settings = undefined;
  state.started.length = 0;
});
afterEach(async () => {
  state.fixture?.close();
  state.fixture = null;
  await rm(state.home, { recursive: true, force: true });
});

let sessionSeq = 0;
/** 开一条 Codex 终端会话,交回它那台 app-server 的启动参数与环境。`platform` = 用户选的是咕咕平台模型。 */
async function terminalEngine(model: string, platform?: typeof PLATFORM) {
  sessionSeq += 1;
  const sessionId = `tui-${sessionSeq}`;
  const before = state.started.length;
  const out = await provisionAndOverride(
    { sessionId, providerId: 'codex', cwd: state.home, baseCommand: state.codexCli, model },
    {
      getAuth: vi.fn(),
      resolveDeviceId: vi.fn(),
      // 与 `startCodexAppServer` 的 loadCapabilities 同一份嫁接:平台额度的会话把平台声明接到模型单元上。
      loadCapabilities: async (_agent: string, _chat: string | null, capability: ModelCapability, autonomy: unknown) =>
        loadCodexAppServerCapabilities(
          {
            mcpServers: [],
            mcpDisabled: undefined,
            env: { GUGU_HOME: join(state.home, 'gugu-home') },
            model: platform ? withPlatformDeclaration(capability, platform) : capability,
            autonomy: autonomy as never,
            promptBlocks: {},
            packages: PRODUCT_CAPABILITY_PACKAGES,
            extensionSkills: [],
            extensionApps: [],
            extensionServerOrigins: [],
          },
          { cwd: state.home, lifecycle: 'fresh' },
        ),
    } as unknown as Parameters<typeof provisionAndOverride>[1],
  );
  expect(out).not.toBeNull();
  expect(state.started).toHaveLength(before + 1);
  return state.started.at(-1)!;
}

const providerPins = (args: readonly string[]) => args.filter((arg) => arg.startsWith('model_provider='));

async function selectCodexKey() {
  const key = await createHarnessConnection({ providerId: 'codex', kind: 'api-key', apiKey: 'codex-secret' });
  await selectHarnessConnection('codex', key.id);
}

it('a Gugu platform model in the terminal stays on the platform while a Codex API key is current', async () => {
  await selectCodexKey();
  const engine = await terminalEngine('gpt-5.6-luna', PLATFORM);
  // 只有平台那一个 provider:连接那组跟在后面,codex 就按后一个把平台模型名发去连接的地址。
  expect(providerPins(engine.extraArgs)).toEqual(['model_provider=gugu_platform']);
  expect(JSON.stringify(engine.extraArgs)).not.toContain('gugu_connection');
  expect(engine.env.OPENAI_API_KEY).toBe('platform-token');
});

it('a native model in the terminal runs on the selected key as its own provider', async () => {
  await selectCodexKey();
  const engine = await terminalEngine('gpt-5.5');
  expect(providerPins(engine.extraArgs)).toEqual(['model_provider="gugu_connection"']);
  expect(engine.extraArgs).toContain('model_providers.gugu_connection.base_url="https://api.openai.com/v1"');
  expect(engine.env.OPENAI_API_KEY).toBe('codex-secret');
  expect(JSON.stringify(engine.extraArgs)).not.toContain('codex-secret');
});

it('extra args the user typed keep their place after the materialized args on both', async () => {
  await selectCodexKey();
  state.settings = { extraArgs: '-c user_pin=1' };
  const native = await terminalEngine('gpt-5.5');
  const nativeAt = native.extraArgs.indexOf('user_pin=1');
  expect(nativeAt).toBeGreaterThan(native.extraArgs.findIndex((arg) => arg.startsWith('model=')));
  expect(nativeAt).toBeLessThan(native.extraArgs.indexOf('model_provider="gugu_connection"'));
  const platform = await terminalEngine('gpt-5.6-luna', PLATFORM);
  expect(platform.extraArgs.indexOf('user_pin=1')).toBeGreaterThan(platform.extraArgs.indexOf('model_provider=gugu_platform'));
  expect(platform.extraArgs.indexOf('user_pin=1')).toBeGreaterThan(platform.extraArgs.indexOf('features.apps=false'));
});

it('a run context whose extra args no longer end with the connection args fails loudly instead of cutting the user’s args', () => {
  const ctx: AgentRunContext = {
    cli: { kind: 'unresolved', message: 'test' },
    env: {},
    configRootEnv: {},
    pinnedEnv: {},
    extraArgs: ['-c', 'user_pin=1'],
    connectionArgs: ['-c', 'model_provider="gugu_connection"'],
  };
  expect(() => runContextLaunchArgs(ctx, { platformQuota: true })).toThrow(/connectionArgs/);
  expect(runContextLaunchArgs(ctx, { platformQuota: false })).toEqual(['-c', 'user_pin=1']);
});
