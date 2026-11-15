import type { ApiKeyConnectionDescriptor, IApiKeyConnectionBehavior } from '@gugu/session-core/agents/plugins';

/**
 * MiMo Code(#2507):小米开放平台的 key,`XIAOMI_API_KEY`(provider `xiaomi`,与 `mimo auth login -p xiaomi` 同一家)。
 * 只收官方 key,没有地址格:地址要换得写进 provider 配置,不是一个环境变量的事。
 * 模型由会话里选(`xiaomi/<模型>`),这把 key 只让那一家的模型可用。
 */
export const mimocodeApiKeyConnection = {
  kind: 'supported',
  endpoint: 'none',
  model: 'none',
  evidence:
    '0.1.13 隔离 HOME:只设 XIAOMI_API_KEY、零登录,`mimo auth list` 在 Environment 下列出 xiaomi、存储凭据 0 条(#2507 调研 group-c)',
} as const satisfies ApiKeyConnectionDescriptor;

export const MIMOCODE_CONNECTION_UNSET_ENV = ['XIAOMI_API_KEY'] as const;

export const mimocodeApiKeyConnectionBehavior: IApiKeyConnectionBehavior = {
  launch: ({ apiKey }) => ({ env: { XIAOMI_API_KEY: apiKey }, unsetEnv: MIMOCODE_CONNECTION_UNSET_ENV }),
};
