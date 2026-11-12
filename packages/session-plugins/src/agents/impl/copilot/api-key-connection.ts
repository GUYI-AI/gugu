import type { ApiKeyConnectionDescriptor, IApiKeyConnectionBehavior } from '@gugu/session-core/agents/plugins';

/**
 * GitHub Copilot CLI(#2507):自带模型地址(BYOK)—— `COPILOT_PROVIDER_*`,地址与模型都必填
 * (不给模型 copilot 起不来:「BYOK providers require an explicit model」)。
 *
 * 用的是平台会话实测过的**同一组**变量(./platform-model.ts:TYPE / WIRE_API / BASE_URL / API_KEY / MODEL_ID),
 * ❌ 不用 `COPILOT_MODEL`:平台会话只覆盖这五个,连接要是写了 `COPILOT_MODEL`,平台会话里它会留下来、跟平台的
 * 模型拼在一起。五个同名 ⇒ 平台会话里整份是平台的,自己的模型那条路整份是这把连接的。
 * 协议:`COPILOT_PROVIDER_WIRE_API=completions` = chat completions(github-copilot-sdk `ProviderConfig.wire_api`
 * 「Defaults to "completions"」;实测不设时 POST /v1/chat/completions,见 ./platform-model.ts)。地址要带 `/v1`。
 */
export const copilotApiKeyConnection = {
  kind: 'supported',
  endpoint: 'required',
  model: 'required',
  protocol: 'openai-chat-completions',
  evidence:
    '只给 COPILOT_PROVIDER_TYPE/BASE_URL/API_KEY/MODEL_ID、零 GitHub 凭据,`copilot -p` exit=0(1.0.80,vendorAccount 同一条);'
    + '1.0.109 ACP session/new 成功、模型表 = Auto + 给的模型(#2507 调研 group-a)',
} as const satisfies ApiKeyConnectionDescriptor;

export const COPILOT_CONNECTION_UNSET_ENV = [
  'COPILOT_PROVIDER_TYPE',
  'COPILOT_PROVIDER_WIRE_API',
  'COPILOT_PROVIDER_BASE_URL',
  'COPILOT_PROVIDER_API_KEY',
  'COPILOT_PROVIDER_BEARER_TOKEN',
  'COPILOT_PROVIDER_API_KEY_COMMAND',
  'COPILOT_PROVIDER_MODEL_ID',
  'COPILOT_MODEL',
] as const;

export const copilotApiKeyConnectionBehavior: IApiKeyConnectionBehavior = {
  launch: ({ apiKey, endpoint, model }) => {
    if (!endpoint || !model) throw new Error('Copilot needs an API address and a model with its API key');
    return {
      env: {
        COPILOT_PROVIDER_TYPE: 'openai',
        COPILOT_PROVIDER_WIRE_API: 'completions',
        COPILOT_PROVIDER_BASE_URL: endpoint,
        COPILOT_PROVIDER_API_KEY: apiKey,
        COPILOT_PROVIDER_MODEL_ID: model,
      },
      unsetEnv: COPILOT_CONNECTION_UNSET_ENV,
    };
  },
};
