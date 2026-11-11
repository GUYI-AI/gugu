import type { ApiKeyConnectionDescriptor } from '@gugu/session-core/agents/plugins';

/**
 * Pi(#2507):自定义地址只写得进 `models.json`(provider 的 `baseUrl` 不展开环境变量,也没有「默认模型」的环境变量),
 * 环境变量够不着 ⇒ 走模型注入:宿主照平台会话造一份模型声明(地址、key、模型来自连接),由 ./session-bundle 的
 * `modelArtifact` / `acpSettingsArtifact` 写进咕咕自有配置根的 `models.json` + `settings.json`,key 只以
 * `${GUGU_PI_API_KEY}` 出现在文档里、真值走进程环境。协议 = 平台那份写法的 `api`(./platform.ts)。
 */
export const piApiKeyConnection = {
  kind: 'supported',
  delivery: 'model-injection',
  endpoint: 'required',
  model: 'required',
  protocol: 'openai-responses',
  evidence:
    '2026-11-12 MBP pi 0.84.2 + @gugu-acp/pi-acp 1.1.0、隔离 HOME:连接的模型声明经物化器写 models.json + settings.json,'
    + 'ACP session/new 选中 gugu-platform/<模型>、一轮回话;终端腿同一份 models.json + `--provider gugu-platform --model` 同样;'
    + '假端点只收到 POST /v1/responses、Bearer 是连接的 key',
} as const satisfies ApiKeyConnectionDescriptor;
