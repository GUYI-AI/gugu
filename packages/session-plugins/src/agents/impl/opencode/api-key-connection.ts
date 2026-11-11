import type { ApiKeyConnectionDescriptor } from '@gugu/session-core/agents/plugins';

/**
 * OpenCode(#2507):自定义地址是配置里的一个 provider 块,而咕咕自己就在写 `OPENCODE_CONFIG_CONTENT`
 * (MCP / 模型 / 提示 / 权限都走这份,`units.*.channel = 'process-config'`)—— 另起一份同名环境变量会被物化器那份
 * 盖掉 ⇒ 走模型注入:宿主照平台会话造模型声明,由 `openCodeFamilyConfigContent` 写进同一份配置文档的 provider 块
 * (`baseURL` + `apiKey` + 模型),与 MCP / 提示合成一份。协议 = 平台那份写法的 `npm` 包(./platform.ts)。
 */
export const opencodeApiKeyConnection = {
  kind: 'supported',
  delivery: 'model-injection',
  endpoint: 'required',
  model: 'required',
  protocol: 'openai-responses',
  evidence:
    '2026-11-12 MBP opencode 1.18.28、隔离 HOME:连接的模型声明写进 OPENCODE_CONFIG_CONTENT 的 provider 块,`opencode acp` 一轮回话、'
    + '`opencode run`(serve 读的同一份配置)同样;假端点只收到 POST /v1/responses、Bearer 是连接的 key',
} as const satisfies ApiKeyConnectionDescriptor;
