import type { ApiKeyConnectionDescriptor, IApiKeyConnectionBehavior } from '@gugu/session-core/agents/plugins';

/**
 * DeepSeek Harness(#2507):`DEEPSEEK_API_KEY`,地址可选(缺省官方 `https://api.deepseek.com/anthropic`)。
 * dsh 在地址后面拼 `/v1/messages`、key 进 `x-api-key` —— Anthropic Messages(./platform.ts 的同一条出处)。
 *
 * 平台会话:`--patch` 文档把 `llm-deepseek` 整行换成中转地址 + `apiKeyEnv: GUGU_DSH_PLATFORM_KEY`(./session-bundle.ts),
 * 那是 dsh 配置的最高一层 ⇒ 这里给的两个变量在平台会话里读都不读。
 * ⚠️ dsh 自己的凭据库(`$DSH_HOME/.credentials.yaml`)先于进程环境(./platform.ts 抬头):用户在 dsh 里存过 key 时,
 *    那一份可能赢过这把连接 —— 厂商的优先级,咕咕这边改不了。
 */
export const dshApiKeyConnection = {
  kind: 'supported',
  endpoint: 'optional',
  // DeepSeek 自己的 Anthropic 兼容地址(api-docs.deepseek.com 的 Anthropic API 指引);不改它 = 不给 DEEPSEEK_BASE_URL,dsh 用它自带的。
  officialEndpoint: 'https://api.deepseek.com/anthropic',
  model: 'none',
  protocol: 'anthropic-messages',
  evidence:
    '0.2.2-rc.1 隔离 DSH_HOME:只给 DEEPSEEK_API_KEY + DEEPSEEK_BASE_URL,`dsh --profile acp` session/prompt,'
    + '假网关收到 POST <base>/v1/messages 带 x-api-key(#2507 调研 group-b,2026-11-12)',
} as const satisfies ApiKeyConnectionDescriptor;

export const DSH_CONNECTION_UNSET_ENV = ['DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL'] as const;

export const dshApiKeyConnectionBehavior: IApiKeyConnectionBehavior = {
  launch: ({ apiKey, endpoint }) => ({
    env: { DEEPSEEK_API_KEY: apiKey, ...(endpoint ? { DEEPSEEK_BASE_URL: endpoint } : {}) },
    unsetEnv: DSH_CONNECTION_UNSET_ENV,
  }),
};
