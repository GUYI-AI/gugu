import type { ModelProtocol } from './custom-model';

export interface ProviderPreset {
  id: string;
  name: string;
  icon: string;
  group: 'coding-plan' | 'api';
  endpoints: { protocol: ModelProtocol; baseUrl: string; source: string }[];
  docsUrl: string;
  sources: string[];
  checkedAt: string;
  modelsListing: boolean;
}

function preset(
  id: string, name: string, icon: string, group: ProviderPreset['group'],
  docsUrl: string, endpoints: [ModelProtocol, string, string?][],
): ProviderPreset {
  const sourced = endpoints.map(([protocol, baseUrl, source = docsUrl]) => ({ protocol, baseUrl, source }));
  return {
    id, name, icon, group, docsUrl, endpoints: sourced,
    sources: [...new Set(sourced.map(({ source }) => source))],
    checkedAt: '2026-11-18',
    modelsListing: sourced.some(({ protocol }) => protocol.startsWith('openai-')),
  };
}

/** Officially documented endpoints only; model names are read from the provider. */
export const providerPresets: readonly ProviderPreset[] = [
  preset('zhipu-coding', '智谱 GLM Coding Plan', 'zhipu', 'coding-plan',
    'https://docs.bigmodel.cn/cn/coding-plan/quick-start', [
      ['anthropic-messages', 'https://open.bigmodel.cn/api/anthropic'],
      ['openai-chat-completions', 'https://open.bigmodel.cn/api/coding/paas/v4'],
      ['openai-responses', 'https://open.bigmodel.cn/api/v1'],
    ]),
  preset('kimi-coding', 'Kimi Code', 'kimi', 'coding-plan',
    'https://www.kimi.com/coding/docs/', [
      ['anthropic-messages', 'https://api.kimi.com/coding/'],
      ['openai-chat-completions', 'https://api.kimi.com/coding/v1'],
      ['openai-responses', 'https://api.kimi.com/coding/v1'],
    ]),
  preset('ark-coding', '火山方舟 Coding Plan', 'volcengine', 'coding-plan',
    'https://www.volcengine.com/docs/82379/1928262', [
      ['anthropic-messages', 'https://ark.cn-beijing.volces.com/api/coding'],
      ['openai-chat-completions', 'https://ark.cn-beijing.volces.com/api/coding/v3'],
    ]),
  preset('zai-coding', 'Z.ai Coding Plan', 'zai', 'coding-plan',
    'https://docs.z.ai/devpack/quick-start', [
      ['anthropic-messages', 'https://api.z.ai/api/anthropic'],
      ['openai-chat-completions', 'https://api.z.ai/api/coding/paas/v4'],
    ]),
  preset('zhipu', '智谱开放平台', 'zhipu', 'api',
    'https://docs.bigmodel.cn/cn/guide/develop/openai/introduction', [
      ['anthropic-messages', 'https://open.bigmodel.cn/api/anthropic', 'https://docs.bigmodel.cn/cn/guide/develop/claude/introduction'],
      ['openai-chat-completions', 'https://open.bigmodel.cn/api/paas/v4'],
      ['openai-responses', 'https://open.bigmodel.cn/api/v1', 'https://docs.bigmodel.cn/cn/guide/develop/responses/introduction'],
    ]),
  preset('moonshot', 'Kimi 开放平台', 'kimi', 'api',
    'https://platform.kimi.com/docs/api/responses.md', [
      ['anthropic-messages', 'https://api.moonshot.cn/anthropic', 'https://platform.kimi.com/docs/api/messages.md'],
      ['openai-chat-completions', 'https://api.moonshot.cn/v1', 'https://platform.kimi.com/docs/guide/codex-kimi.md'],
      ['openai-responses', 'https://api.moonshot.cn/v1'],
    ]),
  preset('deepseek', 'DeepSeek', 'deepseek', 'api',
    'https://api-docs.deepseek.com/', [
      ['anthropic-messages', 'https://api.deepseek.com/anthropic', 'https://api-docs.deepseek.com/guides/anthropic_api'],
      ['openai-chat-completions', 'https://api.deepseek.com'],
    ]),
  preset('minimax', 'MiniMax', 'minimax', 'api',
    'https://platform.minimaxi.com/docs/guides/text-generation', [
      ['anthropic-messages', 'https://api.minimax.cn/anthropic', 'https://platform.minimaxi.com/docs/api-reference/text-anthropic-api'],
      ['openai-chat-completions', 'https://api.minimax.cn/v1'],
    ]),
  preset('openai', 'OpenAI', 'openai', 'api',
    'https://developers.openai.com/api/docs/quickstart', [
      ['openai-chat-completions', 'https://api.openai.com/v1'],
      ['openai-responses', 'https://api.openai.com/v1'],
    ]),
  preset('anthropic', 'Anthropic', 'claude', 'api',
    'https://platform.claude.com/docs/en/api/overview', [
      ['anthropic-messages', 'https://api.anthropic.com'],
    ]),
  preset('gemini', 'Google Gemini', 'google', 'api',
    'https://ai.google.dev/gemini-api/docs/openai', [
      ['openai-chat-completions', 'https://generativelanguage.googleapis.com/v1beta/openai'],
      ['gemini-generate-content', 'https://generativelanguage.googleapis.com/v1beta', 'https://ai.google.dev/gemini-api/docs/text-generation'],
    ]),
  preset('siliconflow', '硅基流动', 'siliconcloud', 'api',
    'https://docs.siliconflow.cn/cn/api-reference/chat-completions/chat-completions', [
      ['openai-chat-completions', 'https://api.siliconflow.cn/v1'],
    ]),
];
