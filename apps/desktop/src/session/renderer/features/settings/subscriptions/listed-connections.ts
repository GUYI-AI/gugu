import { useQuery } from '@tanstack/react-query'
import type { HarnessConnection } from '@gugu/session-core/workspace-server/agent-config'
import type { SubscriptionPayer } from '@gugu/session-core/agents/plugins'
import { agentConnectionForm, type AgentPayload } from '@shared/core/agents/agent-payload'
import { getAgentConfigRuntimeClient } from '@renderer/lib/agent-config/runtime-client'
import { resolveAccountTargets } from '../agents-page/agent-account'
import { errorText } from './subscription-queries'

export function connectionsKey(machine: string | null, providerId: string) {
  return ['subscriptions', machine ?? 'local', providerId, 'connections']
}

/** 有连接的家:Claude / Codex(账号 + API Key),以及声明了 API Key 连接的家(#2507)。 */
export function useSubscriptionConnections(
  machine: string | null,
  agent: Pick<AgentPayload, 'id' | 'capabilities'>,
  background = false
) {
  const providerId = agent.id
  return useQuery({
    queryKey: connectionsKey(machine, providerId),
    queryFn: async () => {
      const result = await (
        await getAgentConfigRuntimeClient(machine)
      ).listConnections({ providerId })
      if (!result.success) throw new Error(errorText(result.error))
      return result.data
    },
    enabled: agentConnectionForm(agent) !== null,
    staleTime: 30_000,
    retry: background,
    retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 30_000)
  })
}

/** 一个连接的登录读数与套餐。菜单里的行、菜单外的「重新登录」与「现有 CLI 配置」列不列,读的是同一份(同一把键)。 */
export function useConnectionDetails(
  machine: string | null,
  providerId: string,
  connectionId: string | undefined
) {
  return useQuery({
    queryKey: [...connectionsKey(machine, providerId), connectionId],
    queryFn: async () => {
      const client = await getAgentConfigRuntimeClient(machine)
      const input = { providerId, connectionId: connectionId! }
      const [status, plan] = await Promise.all([
        client.refreshAuthStatus(input),
        client.readSubscription(input)
      ])
      if (!status.success) throw new Error(errorText(status.error))
      return { status: status.data, plan: plan.success ? plan.data : null }
    },
    enabled: connectionId !== undefined,
    staleTime: 30_000,
    retry: false
  })
}

export type ConnectionDetails = NonNullable<ReturnType<typeof useConnectionDetails>['data']>

/** 读得出「谁在付钱」就说明这份配置真有东西(没登录、判不出都不算)。 */
const CONFIGURED_PAYERS: ReadonlySet<SubscriptionPayer> = new Set(['subscription', 'api-key', 'custom-endpoint'])

/**
 * 「现有 CLI 配置」真有东西:这台电脑上的 CLI 自己登上了,或读得出它配了谁付钱 ——
 * Pi 这类没有登录读数的家,靠的是后一条(它 `/login` 存下的凭据、导出的 Key)。读不出就是没有。
 */
export function nativeConfigured(details: ConnectionDetails | undefined): boolean {
  if (!details) return false
  if (details.status.kind === 'authenticated') return true
  return !!details.plan && CONFIGURED_PAYERS.has(details.plan.payer)
}

/** 只能登它 CLI 自己那一份的家(没有连接可管)真登上时,那一份就是它唯一的连接。 */
const CLI_CONFIGURATION: HarnessConnection = { id: 'native', kind: 'native', name: '', current: true }

/**
 * 一家在「连接」里**真有的**那几条(owner 2026-11-12:「我其实这个 pi 也没配置过，但是你却让我选它的配置……
 * 所以默认应该没有啊，应该是添加连接呀」)。订阅页那一行、资源库详情的「连接」一节、新建任务与会话里打开的面板
 * 读的都是这一份。
 *
 * 「现有 CLI 配置」只在真有东西时列(`nativeConfigured`);读不出、还没读到都不列 —— ❌ 摆一个空的、还打着勾的
 * 占位。选不选它是另一回事:主进程那边没选别的连接时,会话照旧走它(底层不变)。
 *
 * `listed` 为 undefined = 还在读(❌ 拿半份读数先说「没有连接」)。
 */
export function useListedConnections(
  machine: string | null,
  agent: Pick<AgentPayload, 'id' | 'capabilities' | 'programs' | 'status'>,
  background = false
) {
  const form = agentConnectionForm(agent)
  // 账号就是它 CLI 自己那一份(OpenCode、MiMo、Kilo、Copilot、Hermes…):Claude / Codex 的多账号不算在这里。
  const cliSignIn = !form?.accounts && resolveAccountTargets(agent).length > 0
  const offered = form !== null || cliSignIn
  const connections = useSubscriptionConnections(machine, agent, background)
  const native = useConnectionDetails(machine, agent.id, offered ? 'native' : undefined)
  const configured = nativeConfigured(native.data)
  const nativeRead = native.isSuccess || native.isError
  const listed: HarnessConnection[] | undefined = !offered
    ? []
    : !nativeRead
      ? undefined
      : form
        ? connections.data?.filter((connection) => connection.kind !== 'native' || configured)
        : configured
          ? [CLI_CONFIGURATION]
          : []
  return { listed, connections, native, nativeConfigured: configured, form, cliSignIn, offered }
}
