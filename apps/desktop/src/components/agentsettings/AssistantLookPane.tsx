import { useContactsStore } from '../../store/contactsContext'
import { useAuth } from '../../store/auth'
import { agentIdentity } from '../assistantFigure/engine/identity'
import { parseAssistantLook } from '../assistantFigure/look'
import type { AgentSettingsPaneProps } from './types'
import { AssistantLookEditor } from './AssistantLookEditor'

/** 已有 Agent 的形象存储接入；首开引导复用同一编辑器，将选择保留在开通草稿中。 */
export function AssistantLookPane({ agent }: AgentSettingsPaneProps) {
  const { setAssistantLook } = useContactsStore()
  const { user } = useAuth()
  const stored = parseAssistantLook(agent.avatar)

  return (
    <AssistantLookEditor
      id={agent.id}
      name={agent.display_name}
      number={agent.gugu_number}
      current={stored ?? agentIdentity(agent.id)}
      hasSavedLook={stored != null}
      usesPhoto={agent.avatar != null && !stored}
      isOwned={agent.type === 'agent' && !!agent.owner_user_id && agent.owner_user_id === user?.id}
      onSave={async (look) => { await setAssistantLook(agent.id, look) }}
    />
  )
}
