import type { ApiKeyConnectionDescriptor, IApiKeyConnectionBehavior } from '@gugu/session-core/agents/plugins';
import { zcodeProviderTableEnv } from './session-bundle';

/** API Key 连接在 ZCode provider 表里的那一家 id(与平台的 `gugu-platform` 分开)。 */
export const ZCODE_CONNECTION_PROVIDER_ID = 'gugu-connection';

/**
 * ZCode(#2507):与平台会话同一个形状 —— 整份 provider 表进桥的一个环境变量(桥补丁 0007 落成 0600 临时文件交给
 * ZCode 后端),`ZCODE_PROVIDER` 钉菜单。ZCode 的表只认字面 key(`access.apiKey`),所以 key 在表里、只活在进程环境。
 * 协议用 chat completions:ZCode 的表认 `openai-chat-completions`(./platform.ts 抬头的出处),而智谱自己的
 * Coding 端点(`/api/coding/paas/v4`)讲的正是它。平台会话的物化器写同两个变量、压在上面 ⇒ 平台会话里这一份整份让位。
 */
export const zcodeApiKeyConnection = {
  kind: 'supported',
  endpoint: 'required',
  model: 'required',
  protocol: 'openai-chat-completions',
  evidence:
    'ZCode provider 表 api.type 认 anthropic-messages / openai-chat-completions / openai-responses'
    + '(zai-org/ZCode packages/provider/src/config/provider-data-schema.ts);同一份表经 ZCODE_PERSONAL_PROVIDER_CONFIG_CONTENT'
    + ' 交给桥是平台会话实测过的通道(./session-bundle.ts zcodePlatformEnv)',
} as const satisfies ApiKeyConnectionDescriptor;

export const ZCODE_CONNECTION_UNSET_ENV = ['ZCODE_PERSONAL_PROVIDER_CONFIG_CONTENT', 'ZCODE_PROVIDER'] as const;

export const zcodeApiKeyConnectionBehavior: IApiKeyConnectionBehavior = {
  launch: ({ apiKey, endpoint, model }) => {
    if (!endpoint || !model) throw new Error('ZCode needs an API address and a model with its API key');
    return {
      env: zcodeProviderTableEnv({
        providerId: ZCODE_CONNECTION_PROVIDER_ID,
        apiKey,
        apiType: zcodeApiKeyConnection.protocol,
        baseUrl: endpoint,
        selected: model,
        modelIds: [model],
      }),
      unsetEnv: ZCODE_CONNECTION_UNSET_ENV,
    };
  },
};
