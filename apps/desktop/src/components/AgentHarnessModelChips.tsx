import { Chip } from './ui/Chip'
import { AgentHarnessIcon } from './AgentHarnessIdentity'
import { useAgentHarnessName } from '../hooks/useAgentHarness'
import { useAgentModelName } from '../hooks/useAgentModelName'
import { cn } from '@/lib/cn'

/**
 * 「它是什么智能体」(owner 11-25、11-26):harness 与此刻的模型,两枚浅底小胶囊,harness 前带头像角标同款字形。
 * 两样都读在线态(主人、好友、同群的人都收得到);说不出的那一枚不画,模型说不出就只剩 harness,两样都没有整行不画。
 * 群里的资料卡与通讯录名片共用这一个,❌ 各写一份。
 */
export function AgentHarnessModelChips({ agentId, className }: { agentId: string; className?: string }) {
  const harness = useAgentHarnessName(agentId)
  const model = useAgentModelName(agentId)
  if (!harness && !model) return null
  return (
    <div data-agent-harness-model className={cn('flex min-w-0 flex-wrap items-center gap-1', className)}>
      {harness ? (
        <Chip appearance="filled" data-agent-harness-chip>
          {/* 字形只是画:名字紧跟在后面,读屏 ❌ 再念一遍字形的 aria-label。 */}
          <span aria-hidden="true" className="inline-flex"><AgentHarnessIcon agentId={agentId} size={12} /></span>
          <span className="truncate">{harness}</span>
        </Chip>
      ) : null}
      {model ? <Chip appearance="filled" data-agent-model-chip><span className="truncate">{model}</span></Chip> : null}
    </div>
  )
}
