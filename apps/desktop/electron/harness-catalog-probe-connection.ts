/**
 * 模型目录探针看得见选中的「走模型注入」API Key 连接(#2507:pi / opencode / CodeBuddy)。
 *
 * 走环境变量的连接(Hermes、Qwen …)不用这里:它们的环境在 run context 里,探针第一遍照常带着,
 * 于是输入框列出并默认选中连接的模型。走模型注入的那几家,连接只在起会话时由宿主落成模型声明,
 * 探针看不见 ⇒ 菜单里只有咕咕模型(或这家原生目录),默认也落在那边,发消息就走了别处。
 *
 * 这里把**会话那一份**原样搬进探针:同一个 `connectionModelLaunch`(这家自己的平台模型写法造声明),
 * 按这家真会话的通道送 —— 进程配置文档(opencode)、配置文件(pi 的 models.json,只写进这一趟的临时目录)、
 * 或 env 块(CodeBuddy,与平台探针同一载体)。地址、key、模型都是连接的,❌ 占位:探针读到的就是会话会看到的清单。
 *
 * ❌ 不碰平台探针(`harness-catalog-probe-env.ts`):那是给咕咕模型的第二遍,这里是连接这一遍,互不相干。
 */
import type { ProbePlatformCredentials } from './session/main/core/agents/harness-model-catalog'
import type { ConnectionModel } from './session/main/core/agents/harness-connections'
import { materializePiModelConfig } from '@gugu/session-plugins/agents'
import {
  materializeModelCapability,
  providerDeliversModelViaConfigFile,
  providerUsesSessionProcessConfig,
} from './capability-bundle'
import { connectionModelLaunch } from './sessionpage/connection-model-launch'
import { applySessionMaterialization } from './session-materialization'

export function createProbeConnectionCredentials(
  /** 这家此刻选中的模型注入连接(解密后的 key);没选 = null。宿主传 `resolveConnectionModel`。 */
  resolveConnection: (providerId: string) => Promise<ConnectionModel | null>,
): (pluginId: string, scratchDir: string) => Promise<ProbePlatformCredentials | null> {
  return async (pluginId, scratchDir) => {
    const connection = await resolveConnection(pluginId)
    if (!connection) return null
    // 探针说的是 ACP:按 ACP 腿那条通道送(会话页 Chat UI 同一份)。
    const launch = connectionModelLaunch({
      providerId: pluginId,
      surface: 'cui',
      name: connection.name,
      endpoint: connection.endpoint,
      apiKey: connection.apiKey,
      model: connection.model,
    })
    const capability = launch.modelCapability
    if (!capability) throw new Error(`model catalog probe: ${pluginId} API key connection produced no model declaration`)
    // 输入框里连接的模型只叫模型名(pi / opencode 报的是「提供方/模型」)。
    const modelName = connection.model
    // opencode:配置文档就在 spawnEnv 里(`OPENCODE_CONFIG_CONTENT`),与会话同路。
    if (providerUsesSessionProcessConfig(pluginId)) return { env: { ...launch.spawnEnv }, modelName }
    if (providerDeliversModelViaConfigFile(pluginId, 'acp')) {
      // pi:models.json / settings.json 与会话同源,只写这一趟的临时目录;key 只在进程环境里(`GUGU_PI_API_KEY`)。
      if (capability.dialect === 'pi-models-json') {
        const config = materializePiModelConfig('acp', { model: capability, env: { GUGU_HOME: scratchDir } })
        await applySessionMaterialization({ cwd: scratchDir, guguHome: scratchDir, materialization: config })
        return { env: { ...config.env }, modelName }
      }
      // CodeBuddy:会话里那份 `--settings` 文档的 env 块,探针放进进程环境(平台探针同一载体)。
      // 它的 `session/new` 只报自家目录(2.183.0 实测:带着会话那份 --settings 也一样,21 个、当前 default-model),
      // 而 `CODEBUDDY_BASE_URL` 把**任何**模型的请求都送到连接地址(实测选 default-model 也打到连接、model=default-model)
      // ⇒ 声明会话跑的模型、清单只留它;它收 `set_config_option` 设这个 id(实测之后请求都是这个 model)。
      const spawnEnv = Object.fromEntries(
        Object.entries(materializeModelCapability(capability).spawnEnv ?? {}).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        ),
      )
      if (Object.keys(spawnEnv).length === 0) {
        throw new Error(`model catalog probe: ${pluginId} API key connection materialized no environment for the probe`)
      }
      return { env: spawnEnv, sessionModel: { id: connection.model, only: true }, modelName }
    }
    throw new Error(`model catalog probe: ${pluginId} API key connection has no channel the probe can reach`)
  }
}
