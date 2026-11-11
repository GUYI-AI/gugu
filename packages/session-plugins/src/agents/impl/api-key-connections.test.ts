/**
 * #2507「API Key 连接」:每一家的 key 怎么落进进程(env / 先删的继承变量 / 参数),哪些家有、哪些家没有,
 * 平台会话与连接会不会在同一个进程里拼起来,以及选中 API Key 连接时登录态与付费方照它答。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { composeAgentSpawnEnv, type AgentRunContext } from '@gugu/session-core/agents/agent-run-context';
import {
  AgentPluginHost,
  createPluginRegistry,
  type CLIAgentPluginProvider,
  type SessionCapabilityBundle,
} from '@gugu/session-core/agents/plugins';
import { createLocalPluginFs } from '@gugu/session-core/agents/plugins/helpers';
import { NodeExecutionContext } from '@gugu/session-core/exec';
import { noopLogger } from '@gugu/session-shared/logger';
import { createScope } from '@gugu/session-wire/util';
import { listUserExposedPlugins, pluginRegistry } from '../registry';
import { platformModel as copilotPlatformModel } from './copilot/platform-model';
import { materializeQwenSessionBundle } from './qwen/session-bundle';
import { zcodePlatformEnv } from './zcode/session-bundle';

function launch(providerId: string, input: { apiKey: string; endpoint?: string; model?: string }) {
  const behavior = pluginRegistry.get(providerId)!.behavior.apiKeyConnection;
  if (!behavior) throw new Error(`${providerId} has no API key connection behavior`);
  return behavior.launch(input);
}

function declared(providerId: string) {
  return pluginRegistry.get(providerId)!.capabilities.apiKeyConnection;
}

describe('which agents take an API key connection', () => {
  it('only the agents with a verified key mapping declare it; Claude and Codex keep their own connections', () => {
    const withKeys = pluginRegistry
      .getAll()
      .filter((provider) => provider.capabilities.apiKeyConnection.kind === 'supported')
      .map((provider) => provider.metadata.id)
      .sort();
    expect(withKeys).toEqual(['copilot', 'dsh', 'kilocode', 'mimocode', 'qwen', 'zcode']);
    // 声明了就必须有行为:没有行为的声明在表单里摆出一个存了也用不上的格子。
    for (const id of withKeys) expect(pluginRegistry.get(id)!.behavior.apiKeyConnection?.launch).toBeTypeOf('function');
    for (const id of ['claude', 'codex', 'kiro', 'hermes', 'opencode', 'antigravity', 'codebuddy', 'pi']) {
      expect(declared(id)).toEqual({ kind: 'none' });
    }
    // 阳控:这几家确实是开放给用户的那一批里的(名单变了这里要跟着看)。
    const exposed = listUserExposedPlugins().map((provider) => provider.metadata.id);
    for (const id of withKeys) expect(exposed).toContain(id);
  });

  it('declares the form fields and the protocol each address must speak', () => {
    expect(declared('qwen')).toMatchObject({ endpoint: 'required', model: 'required', protocol: 'openai-chat-completions' });
    expect(declared('copilot')).toMatchObject({ endpoint: 'required', model: 'required', protocol: 'openai-chat-completions' });
    expect(declared('zcode')).toMatchObject({ endpoint: 'required', model: 'required', protocol: 'openai-chat-completions' });
    expect(declared('dsh')).toMatchObject({ endpoint: 'optional', model: 'none', protocol: 'anthropic-messages' });
    expect(declared('mimocode')).toMatchObject({ endpoint: 'none', model: 'none' });
    expect(declared('kilocode')).toMatchObject({ endpoint: 'none', model: 'none' });
  });
});

describe('how each key reaches the process', () => {
  const key = 'sk-test';
  const endpoint = 'https://gateway.example/v1';

  it('qwen: the three OpenAI variables together, and drops the inherited family incl. QWEN_OAUTH / QWEN_MODEL', () => {
    expect(launch('qwen', { apiKey: key, endpoint, model: 'qwen3-coder-plus' })).toEqual({
      env: { OPENAI_API_KEY: key, OPENAI_BASE_URL: endpoint, OPENAI_MODEL: 'qwen3-coder-plus' },
      unsetEnv: ['QWEN_OAUTH', 'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_MODEL', 'QWEN_MODEL'],
    });
    expect(() => launch('qwen', { apiKey: key, endpoint })).toThrow(/model/);
  });

  it('dsh: DEEPSEEK_API_KEY, the address only when one was given, both always unset first', () => {
    expect(launch('dsh', { apiKey: key })).toEqual({ env: { DEEPSEEK_API_KEY: key }, unsetEnv: ['DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL'] });
    expect(launch('dsh', { apiKey: key, endpoint: 'https://relay.example/anthropic' })).toEqual({
      env: { DEEPSEEK_API_KEY: key, DEEPSEEK_BASE_URL: 'https://relay.example/anthropic' },
      unsetEnv: ['DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL'],
    });
  });

  it('copilot: the same five COPILOT_PROVIDER_* the platform path writes, chat completions, COPILOT_MODEL removed', () => {
    const result = launch('copilot', { apiKey: key, endpoint, model: 'glm-5.3' });
    expect(result.env).toEqual({
      COPILOT_PROVIDER_TYPE: 'openai',
      COPILOT_PROVIDER_WIRE_API: 'completions',
      COPILOT_PROVIDER_BASE_URL: endpoint,
      COPILOT_PROVIDER_API_KEY: key,
      COPILOT_PROVIDER_MODEL_ID: 'glm-5.3',
    });
    expect(result.unsetEnv).toEqual(expect.arrayContaining(['COPILOT_MODEL', 'COPILOT_PROVIDER_BEARER_TOKEN', 'COPILOT_PROVIDER_API_KEY_COMMAND']));
    expect(result.args).toBeUndefined();
  });

  it('mimocode / kilocode: the official key only', () => {
    expect(launch('mimocode', { apiKey: key })).toEqual({ env: { XIAOMI_API_KEY: key }, unsetEnv: ['XIAOMI_API_KEY'] });
    expect(launch('kilocode', { apiKey: key })).toEqual({ env: { KILO_API_KEY: key }, unsetEnv: ['KILO_API_KEY'] });
  });

  it('zcode: a one-provider table in the bridge env, pinned to the connection provider, chat completions', () => {
    const result = launch('zcode', { apiKey: key, endpoint: 'https://open.bigmodel.cn/api/coding/paas/v4', model: 'glm-5.3' });
    expect(Object.keys(result.env).sort()).toEqual(['ZCODE_PERSONAL_PROVIDER_CONFIG_CONTENT', 'ZCODE_PROVIDER']);
    expect(result.env.ZCODE_PROVIDER).toBe('gugu-connection');
    const table = JSON.parse(result.env.ZCODE_PERSONAL_PROVIDER_CONFIG_CONTENT!);
    expect(table.config.providerConfigRules.providerRules[0]).toEqual({
      providerId: 'gugu-connection',
      config: {
        group: 'standard-personal',
        access: { type: 'api-key', apiKey: key },
        api: { type: 'openai-chat-completions', baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4' },
        personalModelIds: ['glm-5.3'],
      },
    });
    expect(table.config.defaultModelSelection).toEqual({ providerId: 'gugu-connection', modelId: 'glm-5.3', options: { reasoningLevel: 'disabled' } });
    expect(result.unsetEnv).toEqual(['ZCODE_PERSONAL_PROVIDER_CONFIG_CONTENT', 'ZCODE_PROVIDER']);
  });

  it('every variable a connection writes is also unset first, so a shell export of it cannot win', () => {
    const samples: Record<string, { apiKey: string; endpoint?: string; model?: string }> = {
      qwen: { apiKey: key, endpoint, model: 'm' },
      dsh: { apiKey: key, endpoint },
      copilot: { apiKey: key, endpoint, model: 'm' },
      mimocode: { apiKey: key },
      kilocode: { apiKey: key },
      zcode: { apiKey: key, endpoint, model: 'm' },
    };
    for (const [id, input] of Object.entries(samples)) {
      const result = launch(id, input);
      for (const name of Object.keys(result.env)) expect(result.unsetEnv, `${id}:${name}`).toContain(name);
      // 用户 shell 里 export 了同名的另一把 key:选中的连接赢。
      const context: AgentRunContext = {
        cli: { kind: 'resolved', path: id },
        env: { PATH: '/bin', ...Object.fromEntries(result.unsetEnv.map((name) => [name, 'from-shell'])) },
        unsetEnv: [...result.unsetEnv],
        credentialEnv: result.env,
        configRootEnv: {},
        pinnedEnv: {},
        extraArgs: [],
      };
      const spawned = composeAgentSpawnEnv(context);
      expect(JSON.stringify(spawned), id).not.toContain('from-shell');
      expect(spawned).toMatchObject(result.env);
    }
  });
});

describe('a platform session and a connection never mix in one process', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'gugu-api-key-connection-'));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  function context(credentialEnv: Record<string, string>, unsetEnv: readonly string[]): AgentRunContext {
    return {
      cli: { kind: 'resolved', path: 'agent' },
      env: { PATH: '/bin' },
      unsetEnv: [...unsetEnv],
      credentialEnv,
      configRootEnv: {},
      pinnedEnv: {},
      extraArgs: [],
    };
  }

  function qwenBundle(model: SessionCapabilityBundle['model']): SessionCapabilityBundle {
    return {
      mcpServers: [],
      mcpDisabled: undefined,
      env: { GUGU_HOME: join(tmp, 'gugu-home'), HOME: join(tmp, 'home') },
      model,
      autonomy: null,
      promptBlocks: {},
      packages: [],
      extensionSkills: [],
      extensionApps: [],
      extensionServerOrigins: [],
    } as unknown as SessionCapabilityBundle;
  }

  it('qwen: platform sessions run wholly on the platform triple, own-model sessions wholly on the connection', () => {
    const connection = launch('qwen', { apiKey: 'user-key', endpoint: 'https://user.example/v1', model: 'user-model' });
    const ctx = context(connection.env, connection.unsetEnv);
    const materialize = (model: SessionCapabilityBundle['model']) =>
      materializeQwenSessionBundle({ surface: 'acp', lifecycle: 'fresh', cwd: tmp }, qwenBundle(model)).env;

    const platform = composeAgentSpawnEnv(ctx, {
      hostInjections: [materialize({
        dialect: 'qwen-openai-env',
        model: 'glm-5.3',
        platformProvider: { baseUrl: 'https://relay.example/v1', apiKey: 'platform-token' },
      })],
    });
    expect(platform).toMatchObject({ OPENAI_API_KEY: 'platform-token', OPENAI_BASE_URL: 'https://relay.example/v1', OPENAI_MODEL: 'glm-5.3' });
    expect(JSON.stringify(platform)).not.toMatch(/user-key|user\.example|user-model/);

    const own = composeAgentSpawnEnv(ctx, { hostInjections: [materialize(null)] });
    expect(own).toMatchObject({ OPENAI_API_KEY: 'user-key', OPENAI_BASE_URL: 'https://user.example/v1', OPENAI_MODEL: 'user-model' });
    expect(JSON.stringify(own)).not.toContain('platform-token');
  });

  it('copilot and zcode: the platform writes the very same keys, so it replaces the connection whole', () => {
    const copilot = launch('copilot', { apiKey: 'user-key', endpoint: 'https://user.example/v1', model: 'user-model' });
    const copilotPlatform = copilotPlatformModel.load({
      dialect: 'copilot-provider-env',
      model: 'glm-5.3',
      platformProvider: { baseUrl: 'https://relay.example/v1', apiKey: 'platform-token' },
    }).spawnEnv!;
    expect(Object.keys(copilotPlatform).sort()).toEqual(Object.keys(copilot.env).sort());
    const mixed = composeAgentSpawnEnv(context(copilot.env, copilot.unsetEnv), { hostInjections: [copilotPlatform] });
    expect(JSON.stringify(mixed)).not.toMatch(/user-key|user\.example|user-model/);

    const zcode = launch('zcode', { apiKey: 'user-key', endpoint: 'https://user.example/v1', model: 'user-model' });
    const zcodePlatform = zcodePlatformEnv({
      dialect: 'zcode-provider-table',
      model: 'glm-5.3',
      platformProvider: { baseUrl: 'https://relay.example/v1', apiKey: 'platform-token' },
    });
    expect(Object.keys(zcodePlatform).sort()).toEqual(Object.keys(zcode.env).sort());
    const zcodeMixed = composeAgentSpawnEnv(context(zcode.env, zcode.unsetEnv), { hostInjections: [zcodePlatform] });
    expect(JSON.stringify(zcodeMixed)).not.toMatch(/user-key|user\.example|user-model/);
  });
});

describe('an API key connection is signed in, whatever the CLI files say', () => {
  const home = mkdtempSync(join(tmpdir(), 'gugu-api-key-status-'));
  afterAll(() => rmSync(home, { recursive: true, force: true }));

  async function withHost<T>(run: (host: AgentPluginHost) => Promise<T>): Promise<T> {
    const scope = createScope({ label: 'api-key-status', logger: noopLogger });
    const registry = createPluginRegistry<CLIAgentPluginProvider>();
    for (const id of ['qwen', 'mimocode', 'dsh']) registry.register(pluginRegistry.get(id)!);
    const host = new AgentPluginHost({
      scope,
      registry,
      fs: createLocalPluginFs(home),
      homeDir: home,
      exec: new NodeExecutionContext({ env: { PATH: '/bin' } }),
    });
    try {
      return await run(host);
    } finally {
      await scope.dispose();
    }
  }

  const base: AgentRunContext = {
    cli: { kind: 'resolved', path: '/opt/agent' },
    env: { PATH: '/bin', HOME: home },
    configRootEnv: {},
    pinnedEnv: {},
    extraArgs: [],
  };

  it('qwen with no settings file: native reads "not signed in", the selected API key connection reads as an API key on its address', async () => {
    await withHost(async (host) => {
      expect(await host.readSubscription('qwen', base)).toEqual({ success: true, data: { payer: 'not-signed-in' } });
      const connection = launch('qwen', { apiKey: 'k', endpoint: 'https://gateway.example/v1', model: 'm' });
      const selected: AgentRunContext = {
        ...base,
        connectionId: 'c1',
        credentialEnv: connection.env,
        unsetEnv: [...connection.unsetEnv],
        apiKeyConnection: { endpoint: 'https://gateway.example/v1' },
      };
      expect(await host.readSubscription('qwen', selected)).toEqual({ success: true, data: { payer: 'custom-endpoint', endpoint: 'gateway.example' } });
      expect(await host.checkAuthStatus('qwen', selected)).toEqual({ success: true, data: { kind: 'authenticated', credentialKind: 'api-key' } });
      const usage = await host.readSubscriptionUsage('qwen', selected);
      expect(usage.success && usage.data).toMatchObject({ kind: 'unavailable', reason: 'custom-endpoint' });
    });
  });

  it('an official key (mimocode) reads as an API key; a plugin without a subscription reading (dsh) too', async () => {
    await withHost(async (host) => {
      const official: AgentRunContext = { ...base, connectionId: 'c2', credentialEnv: { XIAOMI_API_KEY: 'k' }, apiKeyConnection: {} };
      expect(await host.readSubscription('mimocode', official)).toEqual({ success: true, data: { payer: 'api-key' } });
      expect(await host.checkAuthStatus('mimocode', official)).toEqual({ success: true, data: { kind: 'authenticated', credentialKind: 'api-key' } });
      expect(await host.checkAuthStatus('dsh', base)).toEqual({ success: true, data: { kind: 'unknown' } });
      expect(await host.checkAuthStatus('dsh', { ...base, connectionId: 'c3', apiKeyConnection: {} })).toEqual({
        success: true,
        data: { kind: 'authenticated', credentialKind: 'api-key' },
      });
      expect(await host.readSubscription('dsh', { ...base, connectionId: 'c3', apiKeyConnection: {} })).toEqual({ success: true, data: { payer: 'api-key' } });
    });
  });
});
