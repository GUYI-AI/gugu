import { rendererLogger } from '@/lib/log'
import { messageForUser } from '@/lib/userFacingError'
import type { LibraryAgentsRpc } from '@renderer/features/library/library-host'
import type { MarketAgentInstallPlan } from '@renderer/features/extensions/panel/market-agent-install-plan'
import { getAgentInstallErrorPresentation, getAgentUpdateErrorPresentation } from '@renderer/features/settings/agents-page/agent-install'
import { translateSessionMessage } from '@renderer/localization/locale-store'
import type { AgentInstallError, AgentUpdateError } from '@shared/core/agents/agent-payload'

const log = rendererLogger('phone-market/agent')

export async function runPhoneAgentInstall(
  agents: Pick<LibraryAgentsRpc, 'install' | 'update' | 'onInstallProgress'>,
  deviceId: string,
  agentId: string,
  plan: MarketAgentInstallPlan,
): Promise<boolean> {
  const started = performance.now()
  const context = { deviceId, agentId, operation: plan.kind, method: plan.method, registry: plan.registry ?? 'auto' }
  const operationLabel = `${agentId} ${plan.kind} on ${deviceId.slice(0, 8)}`
  let lastPhase: string | undefined
  let stop: (() => void) | undefined
  let stage = 'transport'
  log.info(context, `Agent operation started (${operationLabel})`)
  try {
    stop = agents.onInstallProgress(progress => {
      if (progress.providerId !== agentId || progress.phase === lastPhase) return
      lastPhase = progress.phase
      log.info({ ...context, phase: lastPhase, elapsedMs: Math.round(performance.now() - started) }, `Agent operation progress (${operationLabel}, ${lastPhase})`)
    })
    const result = await agents[plan.kind](agentId, plan.method, plan.registry) as
      | { success: true } | { success: false; error: AgentInstallError | AgentUpdateError } | null
    stage = 'response'
    if (result?.success === true) {
      log.info({ ...context, elapsedMs: Math.round(performance.now() - started) }, `Agent operation completed (${operationLabel})`)
      return true
    }
    if (result?.success !== false || !result.error) throw new Error(translateSessionMessage('extensions.tileNeedsApp'))
    const { error } = result
    const options = { translate: translateSessionMessage }
    const presentation = plan.kind === 'update'
      ? getAgentUpdateErrorPresentation(error as AgentUpdateError, options)
      : getAgentInstallErrorPresentation(error as AgentInstallError, options)
    stage = 'host'
    const hostStage = 'stage' in error ? error.stage : undefined
    const lastProgress = 'lastProgress' in error ? error.lastProgress : undefined
    const phase = lastProgress?.phase ?? lastPhase
    const detail = messageForUser(presentation.message)
    // Android's WebView logcat prints object arguments as [object Object].
    log.warn({ ...context, stage, type: error.type, phase: lastPhase,
      hostStage, lastProgress, elapsedMs: Math.round(performance.now() - started), error: detail,
    }, `Host did not complete agent operation (${operationLabel}, ${error.type}, ${phase ?? hostStage ?? 'unknown phase'}) ${detail}`)
    throw new Error(detail)
  } catch (error) {
    if (stage !== 'host') {
      const detail = messageForUser(error)
      log.warn({ ...context, stage, phase: lastPhase,
        elapsedMs: Math.round(performance.now() - started), error: detail,
      }, `Agent operation could not be confirmed (${operationLabel}, ${stage}, ${lastPhase ?? 'unknown phase'}) ${detail}`)
    }
    throw error
  } finally {
    stop?.()
  }
}
