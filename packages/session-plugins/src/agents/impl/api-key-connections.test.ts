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
import { createAgentPluginRegistry, listUserExposedPlugins, pluginRegistry, PRODUCT_CAPABILITY_PACKAGES } from '../registry';
import { platformModel as copilotPlatformModel } from './copilot/platform-model';
import { platformModel as hermesPlatformModel } from './hermes/platform-model';
import { hermesPlatformEnv } from './hermes/session-bundle';
import { materializePiModelConfig } from './pi/session-bundle';
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
    expect(withKeys).toEqual(['antigravity', 'codebuddy', 'copilot', 'dsh', 'hermes', 'kilocode', 'mimocode', 'opencode', 'pi', 'qwen', 'zcode']);
    // 声明了就必须说得出 key 怎么进进程:要么自己的 `launch`,要么走模型注入(借这家的平台模型写法)。
    // 没有行为的声明在表单里摆出一个存了也用不上的格子。
    for (const id of withKeys) {
      const plugin = pluginRegistry.get(id)!;
      const descriptor = plugin.capabilities.apiKeyConnection;
      if (descriptor.kind === 'supported' && descriptor.delivery === 'model-injection') {
        expect(plugin.behavior.sessionBundle?.platformModel, id).toBeDefined();
      } else {
        expect(plugin.behavior.apiKeyConnection?.launch, id).toBeTypeOf('function');
      }
    }
    // Kiro:厂商账号是硬门槛(`vendorAccount: required`,没有一把 key 换得掉)。
    for (const id of ['claude', 'codex', 'kiro']) {
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
    expect(declared('hermes')).toMatchObject({ endpoint: 'required', model: 'required', protocol: 'openai-responses' });
    // agy 的网关请求是 genai 形状(`/v1beta/models/<模型>:streamGenerateContent`)。
    expect(declared('antigravity')).toMatchObject({ endpoint: 'required', model: 'required', protocol: 'gemini-generate-content' });
    expect(declared('antigravity')).not.toHaveProperty('delivery');
  });

  it('the model-injection agents name an address and a model, in exactly the protocol their platform model speaks', () => {
    for (const id of ['pi', 'opencode', 'codebuddy']) {
      const plugin = pluginRegistry.get(id)!;
      const platform = plugin.capabilities.sessionBundle.platform;
      if (platform.kind !== 'supported') throw new Error(`${id} has no platform model`);
      expect(declared(id), id).toMatchObject({ delivery: 'model-injection', endpoint: 'required', model: 'required', protocol: platform.wireProtocol });
      // 没有自己的 `launch`:一把 key 的写法就是平台模型那一份。
      expect(plugin.behavior.apiKeyConnection, id).toBeUndefined();
    }
    expect(declared('pi')).toMatchObject({ protocol: 'openai-responses' });
    expect(declared('opencode')).toMatchObject({ protocol: 'openai-responses' });
    expect(declared('codebuddy')).toMatchObject({ protocol: 'openai-chat-completions' });
  });

  it('refuses to register a model-injection connection whose protocol differs from the platform model, or that has none', () => {
    const pi = pluginRegistry.get('pi')!;
    const otherProtocol = {
      ...pi,
      capabilities: { ...pi.capabilities, apiKeyConnection: { ...pi.capabilities.apiKeyConnection, protocol: 'openai-chat-completions' } },
    } as typeof pi;
    expect(() => createAgentPluginRegistry([otherProtocol])).toThrow(
      "Agent plugin 'pi' API key connection speaks openai-chat-completions, its platform model speaks openai-responses"
    );
    const kiro = pluginRegistry.get('kiro')!;
    const noPlatform = {
      ...kiro,
      capabilities: {
        ...kiro.capabilities,
        apiKeyConnection: { kind: 'supported', delivery: 'model-injection', endpoint: 'required', model: 'required', protocol: 'openai-responses', evidence: 'x' },
      },
    } as typeof kiro;
    expect(() => createAgentPluginRegistry([noPlatform])).toThrow(
      "Agent plugin 'kiro' injects its API key connection as a model but declares no platform model"
    );
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

  it('hermes: the four bridge inputs the platform path gives hermes-serve-acp, from the same writer', () => {
    const result = launch('hermes', { apiKey: key, endpoint, model: 'gpt-5.5' });
    expect(result.env).toEqual(
      hermesPlatformEnv({ dialect: 'hermes-serve-env', model: 'gpt-5.5', platformProvider: { baseUrl: endpoint, apiKey: key } })
    );
    expect(result.env).toMatchObject({
      GUGU_HERMES_PLATFORM_BASE_URL: endpoint,
      GUGU_HERMES_PLATFORM_KEY: key,
      GUGU_HERMES_PLATFORM_MODEL: 'gpt-5.5',
    });
    expect(JSON.parse(result.env.GUGU_PLATFORM_MODELS!)).toEqual([{ id: 'gpt-5.5', displayName: 'gpt-5.5', contextWindow: null, efforts: [] }]);
    expect(() => launch('hermes', { apiKey: key, endpoint })).toThrow(/model/);
  });

  it('antigravity: the gateway values plus its rollout switch, nothing that selects an auth method on disk', () => {
    const result = launch('antigravity', { apiKey: key, endpoint, model: 'gemini-3.8-flash' });
    expect(result.env).toEqual({
      AGY_ACP_ENABLE_GATEWAY_AUTH: '1',
      AGY_LLM_GATEWAY_URL: endpoint,
      AGY_LLM_GATEWAY_API_KEY: key,
      AGY_LLM_GATEWAY_MODELS: 'gemini-3.8-flash',
    });
    // 不碰 Google 账号那一族:GEMINI_HOME / GEMINI_API_KEY 都不是连接写的。
    expect(Object.keys(result.env).some((name) => name.startsWith('GEMINI'))).toBe(false);
    // 旧名也会被它读到(`AGY_GATEWAY_*`):一并先删。
    expect(result.unsetEnv).toEqual(expect.arrayContaining(['AGY_GATEWAY_URL', 'AGY_GATEWAY_API_KEY', 'AGY_GATEWAY_HEADERS', 'AGY_LLM_GATEWAY_HEADERS']));
    expect(() => launch('antigravity', { apiKey: key, endpoint })).toThrow(/model/);
    expect(() => launch('antigravity', { apiKey: key, model: 'm' })).toThrow(/address/);
  });

  it('every variable a connection writes is also unset first, so a shell export of it cannot win', () => {
    const samples: Record<string, { apiKey: string; endpoint?: string; model?: string }> = {
      antigravity: { apiKey: key, endpoint, model: 'm' },
      hermes: { apiKey: key, endpoint, model: 'm' },
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

    // hermes:平台信封把同样这四个桥输入整份压在上面。
    const hermes = launch('hermes', { apiKey: 'user-key', endpoint: 'https://user.example/v1', model: 'user-model' });
    const hermesPlatform = hermesPlatformModel.load({
      dialect: 'hermes-serve-env',
      model: 'glm-5.3',
      platformProvider: { baseUrl: 'https://relay.example/v1', apiKey: 'platform-token' },
    }).spawnEnv!;
    expect(Object.keys(hermesPlatform).sort()).toEqual(Object.keys(hermes.env).sort());
    const hermesMixed = composeAgentSpawnEnv(context(hermes.env, hermes.unsetEnv), { hostInjections: [hermesPlatform] });
    expect(JSON.stringify(hermesMixed)).not.toMatch(/user-key|user\.example|user-model/);
  });
});

/**
 * 走模型注入的家(pi / opencode / CodeBuddy):宿主照平台会话造的那份模型声明 —— 地址、key、模型来自连接 ——
 * 经这家**已有的**物化器落进它自己的配置。这里从声明一路走到物化器的产物,看连接的三样都到了该到的地方、
 * key 只在该在的那一处。
 */
describe('model-injection agents: the connection rides their own platform model writer', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'gugu-api-key-injection-'));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));
  const endpoint = 'https://gateway.example/api/v1';
  const apiKey = 'sk-user-connection';

  function declare(providerId: string) {
    return pluginRegistry.get(providerId)!.behavior.sessionBundle!.platformModel!.declare({
      explicitModel: 'user-model',
      requestedEffort: undefined,
      envOverride: () => undefined,
      platformProvider: { baseUrl: endpoint, apiKey },
      platformAccess: null,
      platformModels: undefined,
      contextWindow: undefined,
      callableRoutes: {},
      protocolEnv: () => {
        throw new Error('not for a connection');
      },
    });
  }

  function bundle(model: SessionCapabilityBundle['model'], env: Record<string, string> = {}): SessionCapabilityBundle {
    return {
      sessionKey: 'conn-1',
      mcpServers: [],
      env: { GUGU_HOME: join(tmp, 'gugu-home'), HOME: join(tmp, 'home'), ...env },
      model,
      autonomy: null,
      promptBlocks: {},
      packages: PRODUCT_CAPABILITY_PACKAGES,
    } as unknown as SessionCapabilityBundle;
  }

  it('pi: models.json names the connection address and model; the key is only `${GUGU_PI_API_KEY}` there, its value in the env', () => {
    const model = declare('pi');
    for (const surface of ['acp', 'tui'] as const) {
      const config = materializePiModelConfig(surface, bundle(model));
      expect(config.env.GUGU_PI_API_KEY).toBe(apiKey);
      const models = config.artifacts.find((artifact) => artifact.path.endsWith('models.json'))!;
      const provider = JSON.parse(models.content).providers['gugu-platform'];
      expect(provider).toMatchObject({ baseUrl: endpoint, api: 'openai-responses', apiKey: '${GUGU_PI_API_KEY}' });
      expect(provider.models.map((entry: { id: string }) => entry.id)).toEqual(['user-model']);
      expect(models.content).not.toContain(apiKey);
      if (surface === 'acp') {
        const settings = config.artifacts.find((artifact) => artifact.path.endsWith('settings.json'))!;
        expect(JSON.parse(settings.content)).toMatchObject({ defaultProvider: 'gugu-platform', defaultModel: 'user-model' });
      }
    }
  });

  it('opencode: one config document with the connection as a provider block; no context window guessed', () => {
    const load = pluginRegistry.get('opencode')!.behavior.sessionBundle!.platformModel!.load(declare('opencode'));
    const config = JSON.parse(load.spawnEnv!.OPENCODE_CONFIG_CONTENT!);
    expect(config.model).toBe('gugu-platform/user-model');
    expect(config.provider['gugu-platform']).toMatchObject({ npm: '@ai-sdk/openai', options: { baseURL: endpoint, apiKey } });
    // opencode 1.18.28:`limit` 一出现就要 `context` —— 窗口说不出就整个不写(实测缺它 session/new 起不来)。
    expect(config.provider['gugu-platform'].models['user-model']).not.toHaveProperty('limit');
    // 与咕咕自己的 MCP / 提示合成一份:物化器收它进会话包的环境,整份不丢。
    const materialized = pluginRegistry.get('opencode')!.behavior.sessionBundle!.materialize(
      { surface: 'acp', lifecycle: 'fresh', cwd: tmp },
      bundle(null, load.spawnEnv as Record<string, string>)
    );
    const merged = JSON.parse(String(materialized.env.OPENCODE_CONFIG_CONTENT));
    expect(merged.model).toBe('gugu-platform/user-model');
    expect(merged.provider['gugu-platform'].options).toEqual({ baseURL: endpoint, apiKey });
  });

  it('codebuddy: address and model in the --settings document, the key only in the process env', () => {
    for (const surface of ['acp', 'tui'] as const) {
      const materialized = pluginRegistry.get('codebuddy')!.behavior.sessionBundle!.materialize(
        { surface, lifecycle: 'fresh', cwd: tmp },
        bundle(declare('codebuddy'))
      );
      expect(materialized.env.CODEBUDDY_API_KEY).toBe(apiKey);
      const settingsPath = materialized.argsAppend[materialized.argsAppend.indexOf('--settings') + 1];
      const document = materialized.artifacts.find((artifact) => artifact.path === settingsPath)!;
      expect(JSON.parse(document.content).env).toEqual({
        CODEBUDDY_BASE_URL: endpoint,
        CODEBUDDY_MODEL: 'user-model',
        CODEBUDDY_SMALL_FAST_MODEL: 'user-model',
        CODEBUDDY_BIG_SLOW_MODEL: 'user-model',
        CODEBUDDY_CODE_SUBAGENT_MODEL: 'user-model',
      });
      expect(document.content).not.toContain(apiKey);
    }
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
