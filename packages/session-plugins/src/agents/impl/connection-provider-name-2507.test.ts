/**
 * #2507 连接在这一家自己界面里的提供方名字。
 *
 * ① 选咕咕模型的会话:启动值逐字节不变 —— 下面的内联快照是改动前(9eb317e326)的原样输出,一个字节都不许动。
 * ② 一把 API Key 连接:pi 的提供方(它的 TUI 显示提供方 **id**)、opencode 的提供方(它的 TUI 显示提供方 **name**)
 *    都是连接的名字;哪里都不出现「Gugu 平台额度」「gugu-platform」。
 */
import { describe, expect, it } from 'vitest';
import type { PlatformModelInput, SessionCapabilityBundle, SessionModelCapability } from '@gugu/session-core/agents/plugins';
import { openCodeFamilyModelConfig } from '../helpers/opencode-family-model-config';
import { pluginRegistry, PRODUCT_CAPABILITY_PACKAGES } from '../registry';
import { OPENCODE_FAMILY_MODEL_SPEC } from './opencode/session-bundle';
import { materializePiModelConfig } from './pi/session-bundle';

const GUGU_HOME = '/fixed/gugu-home';

/** 一条平台会话的签发(两个可切的咕咕模型、带窗口、带推理档)。 */
const PLATFORM_INPUT: PlatformModelInput = {
  explicitModel: 'glm-5.3',
  requestedEffort: 'high',
  envOverride: () => undefined,
  platformProvider: { baseUrl: 'https://relay.example/v1', apiKey: 'sk-session' },
  platformAccess: { relayUrl: 'https://relay.example', token: 'sk-session', contextWindow: 200_000 },
  platformModels: [
    { id: 'glm-5.3', displayName: 'GLM 5.3', contextWindow: 200_000 },
    { id: 'kimi-k3', displayName: 'Kimi K3', contextWindow: 256_000 },
  ],
  contextWindow: 200_000,
  callableRoutes: {},
  protocolEnv: () => ({}),
};

function declare(providerId: string, input: PlatformModelInput = PLATFORM_INPUT): SessionModelCapability {
  return pluginRegistry.get(providerId)!.behavior.sessionBundle!.platformModel!.declare(input);
}

function bundle(model: SessionModelCapability): Pick<SessionCapabilityBundle, 'env' | 'model'> {
  return { env: { GUGU_HOME }, model };
}

function pi(model: SessionModelCapability) {
  return Object.fromEntries(
    (['acp', 'tui'] as const).map((surface) => {
      const config = materializePiModelConfig(surface, bundle(model));
      return [surface, { env: config.env, artifacts: config.artifacts.map(({ path, content }) => ({ path, content })) }];
    }),
  );
}

describe('a Gugu-model (platform) session: launch values byte-for-byte as before', () => {
  it('pi: models.json, settings.json and env', () => {
    expect(pi(declare('pi'))).toMatchInlineSnapshot(`
      {
        "acp": {
          "artifacts": [
            {
              "content": "{
        "quietStartup": true,
        "defaultProvider": "gugu-platform",
        "defaultModel": "glm-5.3",
        "defaultThinkingLevel": "high"
      }
      ",
              "path": "/fixed/gugu-home/.pi/acp-agent/settings.json",
            },
            {
              "content": "{
        "providers": {
          "gugu-platform": {
            "name": "Gugu platform quota",
            "api": "openai-responses",
            "baseUrl": "https://relay.example/v1",
            "apiKey": "\${GUGU_PI_API_KEY}",
            "authHeader": true,
            "models": [
              {
                "id": "glm-5.3",
                "name": "glm-5.3",
                "api": "openai-responses",
                "reasoning": true,
                "contextWindow": 200000
              },
              {
                "id": "kimi-k3",
                "name": "Kimi K3",
                "api": "openai-responses",
                "reasoning": true,
                "contextWindow": 256000
              }
            ]
          }
        }
      }
      ",
              "path": "/fixed/gugu-home/.pi/acp-agent/models.json",
            },
          ],
          "env": {
            "GUGU_PI_API_KEY": "sk-session",
            "PI_CODING_AGENT_DIR": "/fixed/gugu-home/.pi/acp-agent",
          },
        },
        "tui": {
          "artifacts": [
            {
              "content": "{
        "providers": {
          "gugu-platform": {
            "name": "Gugu platform quota",
            "api": "openai-responses",
            "baseUrl": "https://relay.example/v1",
            "apiKey": "\${GUGU_PI_API_KEY}",
            "authHeader": true,
            "models": [
              {
                "id": "glm-5.3",
                "name": "glm-5.3",
                "api": "openai-responses",
                "reasoning": true,
                "contextWindow": 200000
              },
              {
                "id": "kimi-k3",
                "name": "Kimi K3",
                "api": "openai-responses",
                "reasoning": true,
                "contextWindow": 256000
              }
            ]
          }
        }
      }
      ",
              "path": "/fixed/gugu-home/.pi/agent/models.json",
            },
          ],
          "env": {
            "GUGU_PI_API_KEY": "sk-session",
            "PI_CODING_AGENT_DIR": "/fixed/gugu-home/.pi/agent",
          },
        },
      }
    `);
  });

  it('opencode / mimocode / kilocode: the process config document', () => {
    const documents = Object.fromEntries(
      ['opencode', 'mimocode', 'kilocode'].map((providerId) => [
        providerId,
        pluginRegistry.get(providerId)!.behavior.sessionBundle!.platformModel!.load(declare(providerId)).spawnEnv,
      ]),
    );
    expect(documents).toMatchInlineSnapshot(`
      {
        "kilocode": {
          "KILO_CONFIG_CONTENT": "{"provider":{"gugu-platform":{"npm":"@ai-sdk/openai","name":"Gugu 平台额度","options":{"baseURL":"https://relay.example/v1","apiKey":"sk-session"},"models":{"glm-5.3":{"limit":{"output":131072,"context":200000},"variants":{"low":{"reasoningEffort":"low"},"medium":{"reasoningEffort":"medium"},"high":{"reasoningEffort":"high"}},"options":{"reasoningEffort":"high"}},"kimi-k3":{"limit":{"output":131072,"context":256000},"variants":{"low":{"reasoningEffort":"low"},"medium":{"reasoningEffort":"medium"},"high":{"reasoningEffort":"high"}},"options":{"reasoningEffort":"high"}}}}},"model":"gugu-platform/glm-5.3"}",
        },
        "mimocode": {
          "MIMOCODE_CONFIG_CONTENT": "{"provider":{"gugu-platform":{"npm":"@ai-sdk/openai","name":"Gugu 平台额度","options":{"baseURL":"https://relay.example/v1","apiKey":"sk-session"},"models":{"glm-5.3":{"limit":{"output":131072,"context":200000},"variants":{"low":{"reasoningEffort":"low"},"medium":{"reasoningEffort":"medium"},"high":{"reasoningEffort":"high"}}},"kimi-k3":{"limit":{"output":131072,"context":256000},"variants":{"low":{"reasoningEffort":"low"},"medium":{"reasoningEffort":"medium"},"high":{"reasoningEffort":"high"}}}}}},"model":"gugu-platform/glm-5.3"}",
        },
        "opencode": {
          "OPENCODE_CONFIG_CONTENT": "{"provider":{"gugu-platform":{"npm":"@ai-sdk/openai","name":"Gugu 平台额度","options":{"baseURL":"https://relay.example/v1","apiKey":"sk-session"},"models":{"glm-5.3":{"limit":{"output":131072,"context":200000},"variants":{"low":{"reasoningEffort":"low"},"medium":{"reasoningEffort":"medium"},"high":{"reasoningEffort":"high"}},"options":{"reasoningEffort":"high"}},"kimi-k3":{"limit":{"output":131072,"context":256000},"variants":{"low":{"reasoningEffort":"low"},"medium":{"reasoningEffort":"medium"},"high":{"reasoningEffort":"high"}},"options":{"reasoningEffort":"high"}}}}},"model":"gugu-platform/glm-5.3"}",
        },
      }
    `);
  });

  it('pi terminal leg: the argv that picks the model', () => {
    const materialized = pluginRegistry.get('pi')!.behavior.sessionBundle!.materialize(
      { surface: 'tui', lifecycle: 'fresh', cwd: '/fixed/cwd' },
      {
        sessionKey: 'platform-1',
        mcpServers: [],
        env: { GUGU_HOME, HOME: '/fixed/home' },
        model: declare('pi'),
        autonomy: null,
        promptBlocks: {},
        packages: PRODUCT_CAPABILITY_PACKAGES,
      } as unknown as SessionCapabilityBundle,
    );
    expect(materialized.argsAppend).toMatchInlineSnapshot(`
      [
        "--provider",
        "gugu-platform",
        "--model",
        "glm-5.3",
      ]
    `);
  });

  it('opencode session bundle: the model half of the merged document', () => {
    // 序列化之后比:合进进程配置文档的就是这份 JSON,键序也算字节。
    expect(JSON.stringify(openCodeFamilyModelConfig(OPENCODE_FAMILY_MODEL_SPEC, declare('opencode')))).toMatchInlineSnapshot(`"{"provider":{"gugu-platform":{"npm":"@ai-sdk/openai-compatible","name":"Gugu 平台额度","options":{"baseURL":"https://relay.example/v1","apiKey":"sk-session"},"models":{"glm-5.3":{"limit":{"output":131072,"context":200000},"variants":{"low":{"reasoningEffort":"low"},"medium":{"reasoningEffort":"medium"},"high":{"reasoningEffort":"high"}},"options":{"reasoningEffort":"high"}}}}},"model":"gugu-platform/glm-5.3"}"`);
  });
});

/** 一把 API Key 连接造的声明:与 `connectionModelLaunch` 同一份入参,外加连接的名字。 */
function connectionDeclaration(providerId: string, name: string): SessionModelCapability {
  const declared = declare(providerId, {
    explicitModel: 'user-model',
    requestedEffort: undefined,
    envOverride: () => undefined,
    platformProvider: { baseUrl: 'https://gateway.example/v1', apiKey: 'sk-user' },
    platformAccess: null,
    platformModels: undefined,
    contextWindow: undefined,
    callableRoutes: {},
    protocolEnv: () => {
      throw new Error('not for a connection');
    },
  });
  return { ...declared, providerName: name };
}

const PLATFORM_WORDING = /gugu-platform|Gugu platform quota|Gugu 平台额度/;

describe('an API key connection: the harness names the provider after the connection', () => {
  it('pi: the provider id (what pi shows) is the connection name, on both legs and in the argv', () => {
    const model = connectionDeclaration('pi', 'Pi 1');
    for (const [surface, config] of Object.entries(pi(model))) {
      const models = config.artifacts.find((artifact) => artifact.path.endsWith('models.json'))!;
      const provider = JSON.parse(models.content).providers;
      expect(Object.keys(provider), surface).toEqual(['Pi 1']);
      expect(provider['Pi 1'], surface).toMatchObject({ name: 'Pi 1', baseUrl: 'https://gateway.example/v1' });
      for (const artifact of config.artifacts) expect(artifact.content, artifact.path).not.toMatch(PLATFORM_WORDING);
    }
    const settings = pi(model).acp.artifacts.find((artifact) => artifact.path.endsWith('settings.json'))!;
    expect(JSON.parse(settings.content)).toMatchObject({ defaultProvider: 'Pi 1', defaultModel: 'user-model' });
    const materialized = pluginRegistry.get('pi')!.behavior.sessionBundle!.materialize(
      { surface: 'tui', lifecycle: 'fresh', cwd: '/fixed/cwd' },
      {
        sessionKey: 'conn-1',
        mcpServers: [],
        env: { GUGU_HOME, HOME: '/fixed/home' },
        model,
        autonomy: null,
        promptBlocks: {},
        packages: PRODUCT_CAPABILITY_PACKAGES,
      } as unknown as SessionCapabilityBundle,
    );
    expect(materialized.argsAppend).toEqual(['--provider', 'Pi 1', '--model', 'user-model']);
  });

  it('pi: a `/` in the name cannot become the id (pi-acp splits `provider/model` on it); the display name keeps it', () => {
    const models = pi(connectionDeclaration('pi', '团队/备用')).acp.artifacts.find((artifact) => artifact.path.endsWith('models.json'))!;
    expect(JSON.parse(models.content).providers).toEqual({ '团队-备用': expect.objectContaining({ name: '团队/备用' }) });
  });

  it('opencode family: a fixed provider id, the connection name as the provider name (what opencode shows)', () => {
    for (const providerId of ['opencode', 'mimocode', 'kilocode']) {
      const load = pluginRegistry.get(providerId)!.behavior.sessionBundle!.platformModel!.load(connectionDeclaration(providerId, '我的 Key'));
      const [content] = Object.values(load.spawnEnv ?? {});
      const document = JSON.parse(content!);
      expect(document.model, providerId).toBe('api-key-connection/user-model');
      expect(document.provider, providerId).toEqual({
        'api-key-connection': expect.objectContaining({ name: '我的 Key', options: { baseURL: 'https://gateway.example/v1', apiKey: 'sk-user' } }),
      });
      expect(content, providerId).not.toMatch(PLATFORM_WORDING);
    }
    const merged = openCodeFamilyModelConfig(OPENCODE_FAMILY_MODEL_SPEC, connectionDeclaration('opencode', '我的 Key'));
    expect(merged).toMatchObject({ model: 'api-key-connection/user-model', provider: { 'api-key-connection': { name: '我的 Key' } } });
    expect(JSON.stringify(merged)).not.toMatch(PLATFORM_WORDING);
  });
});
