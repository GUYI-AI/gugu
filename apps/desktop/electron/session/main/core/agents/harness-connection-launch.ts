import { CODEX_PLATFORM_PROVIDER_ID } from '@gugu/session-plugins/agents';
import { CODEX_LEGACY_CONNECTION_PROVIDER_ID, withCodexLegacyConnectionProvider } from '@gugu/session-plugins/agents/codex-history';
/**
 * 选了 Claude 账号 / API 连接时,用户 shell 里继承来的这些认证变量不能顶掉所选的那个
 * (API key 环境变量在 Claude CLI 里优先于订阅登录)。
 */
export const CLAUDE_CONNECTION_UNSET_ENV = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
] as const;

/**
 * Claude API 连接跑在用户自己的根上(#26):key 与端点只走环境变量,❌ 不再给它另起一个配置根 ——
 * 那样会话就得换根,对话历史跟着丢。官方端点用 API key 认证,兼容的第三方端点用 bearer。
 */
export function claudeApiKeyEnv(apiKey: string, endpoint?: string, model?: string): Record<string, string> {
  const bearer = Boolean(endpoint && new URL(endpoint).hostname !== 'api.anthropic.com');
  return {
    [bearer ? 'ANTHROPIC_AUTH_TOKEN' : 'ANTHROPIC_API_KEY']: apiKey,
    ...(endpoint ? { ANTHROPIC_BASE_URL: endpoint } : {}),
    ...(model ? { ANTHROPIC_MODEL: model } : {}),
  };
}

/** 选了 Codex 账号 / API 连接时,用户 shell 里继承来的这些认证变量不能顶掉所选的那个。 */
export const CODEX_CONNECTION_UNSET_ENV = [
  'OPENAI_API_KEY',
  'CODEX_API_KEY',
  'OPENAI_BASE_URL',
  'OPENAI_ORG_ID',
  'OPENAI_ORGANIZATION',
  'OPENAI_PROJECT_ID',
] as const;

/**
 * Codex API 连接跑在用户自己的根上(#26):provider 用 `-c` 现给,key 走 `OPENAI_API_KEY`,
 * ❌ 不再写进某个独立根的 config.toml —— 那样会话就得换根,对话历史跟着丢。
 */
export function codexApiKeyConnectionArgs(id: string, endpoint: string, upstreamEndpoint: string, model?: string): string[] {
  const official = isCodexOfficialApiEndpoint(upstreamEndpoint);
  const provider = official ? CODEX_LEGACY_CONNECTION_PROVIDER_ID : CODEX_PLATFORM_PROVIDER_ID;
  const args = [
    ...(model ? ['-c', `model=${JSON.stringify(model)}`] : []),
    '-c', `model_provider=${JSON.stringify(provider)}`,
    '-c', `model_providers.${provider}.name=${JSON.stringify(id)}`,
    '-c', `model_providers.${provider}.base_url=${JSON.stringify(endpoint)}`,
    '-c', `model_providers.${provider}.env_key="OPENAI_API_KEY"`,
    '-c', `model_providers.${provider}.wire_api="responses"`,
  ];
  return official ? args : withCodexLegacyConnectionProvider(args);
}

export function isCodexOfficialApiEndpoint(endpoint: string): boolean {
  return new URL(endpoint).hostname === 'api.openai.com';
}
