import type { ApiKeyConnectionDescriptor } from '@gugu/session-core/agents/plugins';

/**
 * CodeBuddy(#2507):`CODEBUDDY_BASE_URL` / `CODEBUDDY_API_KEY` / `CODEBUDDY_MODEL` 进进程环境就能跑,但用户
 * `~/.codebuddy/settings.json` 的 `env` 块压得住进程环境(./platform.ts 实测 G),只有 `--settings` 那一层压得住它
 * ⇒ 走模型注入:宿主照平台会话造模型声明,由 ./session-bundle 写进 0600 的 `--settings` 文档(地址与各槽位的模型),
 * key 单走进程环境(它把 settings 文档整份打进自己的日志)。协议 = 平台那份写法(`{base}/chat/completions`)。
 */
export const codebuddyApiKeyConnection = {
  kind: 'supported',
  delivery: 'model-injection',
  endpoint: 'required',
  model: 'required',
  protocol: 'openai-chat-completions',
  evidence:
    '2026-11-12 MBP 隔离装的 @tencent-ai/codebuddy-code 2.183.0、隔离 HOME:连接的模型声明写进 `--settings` 文档、key 进进程环境,'
    + '`codebuddy --acp` 一轮回话、`-p` 终端腿同样;假端点只收到 POST /v1/chat/completions、Bearer 是连接的 key',
} as const satisfies ApiKeyConnectionDescriptor;
