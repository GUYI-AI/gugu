import type { SessionModelCapability } from '@gugu/session-core/agents/plugins'
import { pluginRegistry } from '@gugu/session-plugins/agents'
import { materializeModelCapability, providerDeliversModelViaConfigFile } from '../capability-bundle'
import type { SessionpagePlatformModel } from './sessionpage-platform-model'

/**
 * 一把「走模型注入」的 API Key 连接(#2507,`apiKeyConnection.delivery = 'model-injection'`)落成的启动值 ——
 * 与平台会话**同一个形状**,于是 ACP / 终端两条腿、会话包与物化器都按平台那条测过的路把它送进这一家自己的配置
 * (pi 的 `models.json`、opencode 的 `OPENCODE_CONFIG_CONTENT`、CodeBuddy 的 `--settings`)。
 *
 * 与平台会话只差在来路:地址、key、模型都是这把连接的,由这一家自己的平台模型写法(`platformModel.declare`)造声明。
 *
 * ⚠️ 它**不是**平台会话,而判「是不是平台」的那几格全按不是来填:
 *  · `accessSessionId` / `expiresAt` = null —— 没有签过任何咕咕令牌,也就没有续期、结算、撤销(❌ 进 `activeAccessSessions`);
 *  · `env` = {} —— 那一格是平台中转的通用环境;宿主拿「它非空」判平台会话(`platformConfigured`、信封注入器);
 *  · `model` = null —— 「这份额度指定的平台模型」;连接的模型在 `modelCapability.model` 里。
 * ⚠️ 地址原样用:用户填的就是这家要的根(OpenAI 面带不带 `/v1` 由那台服务定),❌ 像平台中转那样补 `/v1`。
 * 提供方叫**连接的名字**(`providerName`):地址和 key 都是用户的,这一家的界面上 ❌ 出现「Gugu 平台额度」/ `gugu-platform`。
 */
export function connectionModelLaunch(input: {
  providerId: string
  surface: 'cui' | 'tui'
  /** 连接的名字(用户的备注,或建连接时生成的「Pi 1」这类)。 */
  name: string
  endpoint: string
  apiKey: string
  model: string
}): SessionpagePlatformModel {
  const plugin = pluginRegistry.get(input.providerId)
  const platformModel = plugin?.behavior.sessionBundle?.platformModel
  if (!plugin || plugin.capabilities.sessionBundle.platform.kind !== 'supported' || !platformModel) {
    throw new Error(`${input.providerId}: an API key connection injected as a model needs this agent's platform model writer`)
  }
  const platformProvider = { baseUrl: input.endpoint, apiKey: input.apiKey }
  const declared = platformModel.declare({
    explicitModel: input.model,
    requestedEffort: undefined,
    // 调试开关只给平台会话:一把连接点名的模型就是它的模型。
    envOverride: () => undefined,
    platformProvider,
    platformAccess: null,
    platformModels: undefined,
    // 连接说不出窗口:不说,让这一家用它自己的默认(❌ 猜一个数)。
    contextWindow: undefined,
    callableRoutes: {},
    protocolEnv: () => {
      throw new Error(`${input.providerId}: an API key connection carries no platform protocol environment`)
    },
  })
  const modelCapability: SessionModelCapability = { ...declared, providerName: input.name }
  const viaConfigFile = providerDeliversModelViaConfigFile(input.providerId, input.surface === 'tui' ? 'tui' : 'acp')
  const materialized = viaConfigFile ? {} : materializeModelCapability(modelCapability)
  if (materialized.settingsOverride) {
    throw new Error(`${input.providerId}: an API key connection cannot ride a session settings document`)
  }
  const spawnEnv = Object.fromEntries(
    Object.entries(materialized.spawnEnv ?? {}).filter((entry): entry is [string, string] => entry[1] !== undefined),
  )
  return {
    accessSessionId: null,
    expiresAt: null,
    env: {},
    model: null,
    spawnEnv,
    clientArgs: [],
    adapterArgs: input.surface === 'tui' ? [] : [...(materialized.extraArgs ?? [])],
    settingsDocumentPath: null,
    platformProvider,
    contextWindow: null,
    reasoningEfforts: null,
    modelCapability,
    switchableModels: [],
  }
}

/** 解析下来不上平台(没签令牌、没有模型声明)—— 只有这时,一把连接才接得上。 */
export function notOnPlatform(platform: SessionpagePlatformModel): boolean {
  return platform.accessSessionId === null && platform.modelCapability === null
}
