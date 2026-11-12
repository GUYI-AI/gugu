import type { ApiKeyConnectionDescriptor, IApiKeyConnectionBehavior } from '@gugu/session-core/agents/plugins';

/**
 * Kilo Code(#2507):Kilo 网关的 key,`KILO_API_KEY`(内置 provider `kilo`,./auth.ts 的 `builtinProvider` 同一个名字)。
 * 只收官方 key,没有地址格;模型由会话里选。
 */
export const kilocodeApiKeyConnection = {
  kind: 'supported',
  endpoint: 'none',
  model: 'none',
  evidence:
    'Kilo 内置 provider `kilo` 读 KILO_API_KEY(./auth.ts builtinProvider;Kilo-Org/kilocode packages/opencode 的 provider 表,#2507 调研 group-c)',
} as const satisfies ApiKeyConnectionDescriptor;

export const KILOCODE_CONNECTION_UNSET_ENV = ['KILO_API_KEY'] as const;

export const kilocodeApiKeyConnectionBehavior: IApiKeyConnectionBehavior = {
  launch: ({ apiKey }) => ({ env: { KILO_API_KEY: apiKey }, unsetEnv: KILOCODE_CONNECTION_UNSET_ENV }),
};
