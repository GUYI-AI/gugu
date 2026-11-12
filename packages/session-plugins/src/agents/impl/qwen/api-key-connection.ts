import { OPENAI_OFFICIAL_ENDPOINT } from '@gugu/session-core/agents/plugins';
import type { ApiKeyConnectionDescriptor, IApiKeyConnectionBehavior } from '@gugu/session-core/agents/plugins';

/**
 * Qwen Code(#2507):三个 OpenAI 变量缺一不可 —— qwen 靠它们齐不齐自选 `openai` 鉴权,缺 `OPENAI_MODEL` 拒启动
 * (与平台会话的 `applyModelEnv` 同一条实测,见 ./session-bundle.ts)。
 *
 * 删掉的继承变量:`getAuthTypeFromEnv` 先判 `QWEN_OAUTH`,模型认 `OPENAI_MODEL` 或别名 `QWEN_MODEL`
 * (@qwen-code/qwen-code 0.21.15 `chunks/chunk-AKN26LMT.js:306`)。
 *
 * 平台会话:物化器的 `applyModelEnv` 写**同样这三个**、压在上面(宿主注入层)⇒ 平台会话里这三个整份是平台的;
 * 自己的模型那条路 `applyModelEnv` 一个都不写 ⇒ 整份是这把连接的。两份不会在一个进程里拼起来。
 */
export const qwenApiKeyConnection = {
  kind: 'supported',
  endpoint: 'required',
  officialEndpoint: OPENAI_OFFICIAL_ENDPOINT,
  model: 'required',
  protocol: 'openai-chat-completions',
  evidence: '只给 OPENAI_BASE_URL/API_KEY/MODEL 三件套、零 Qwen 账号,`qwen -p` exit=0,假端点收到 chat/completions(vendorAccount 同一条)',
} as const satisfies ApiKeyConnectionDescriptor;

export const QWEN_CONNECTION_UNSET_ENV = [
  'QWEN_OAUTH',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'OPENAI_MODEL',
  'QWEN_MODEL',
] as const;

export const qwenApiKeyConnectionBehavior: IApiKeyConnectionBehavior = {
  launch: ({ apiKey, endpoint, model }) => {
    if (!endpoint || !model) throw new Error('Qwen Code needs an API address and a model with its API key');
    return {
      env: { OPENAI_API_KEY: apiKey, OPENAI_BASE_URL: endpoint, OPENAI_MODEL: model },
      unsetEnv: QWEN_CONNECTION_UNSET_ENV,
    };
  },
};
