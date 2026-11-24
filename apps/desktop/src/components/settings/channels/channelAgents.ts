import { useMemo } from 'react'
import type { ContactUser } from '@gugu/core/shared/types/contacts'
import type { ChatChannelList } from '@gugu/core/cloud/chatChannels'
import { rendererChatChannelsClient } from '@/lib/chatChannels'
import { useEntry, useReplica } from '@/lib/replica'
import { chatChannels } from '@/components/connections/connection-replicas'
import { useAuth } from '../../../store/auth'
import { useContactsStore } from '../../../store/contactsContext'
import { compareByRecentActivity } from '@gugu/core/shared/ui/chatModels'
import { useAgentActivityMs } from '@/hooks/useAgentActivityMs'

/** 自己名下的 agent,按智能体的那一种次序(compareByRecentActivity);聊天渠道只能对接自己的(管家那边也验)。 */
export function useOwnedAgents(): ContactUser[] {
  const { user } = useAuth()
  const { contacts } = useContactsStore()
  const owned = useMemo(
    () => contacts.filter((contact) => contact.type === 'agent' && user?.id && contact.owner_user_id === user.id),
    [contacts, user?.id],
  )
  const byId = useMemo(() => Object.fromEntries(owned.map((agent) => [agent.id, agent])), [owned])
  const activityMs = useAgentActivityMs(useMemo(() => owned.map((agent) => agent.id), [owned]), byId)
  return useMemo(() => [...owned].sort((a, b) => compareByRecentActivity({ id: a.id, activityMs: activityMs(a.id) }, { id: b.id, activityMs: activityMs(b.id) })), [owned, activityMs])
}

/** The account's chat channels for a surface that connects WeChat: the channels client, the reading, its list and `apply`. */
export function useChatChannels() {
  const client = useMemo(() => rendererChatChannelsClient(), [])
  const reading = useReplica(chatChannels, [])
  // A change answers with the whole list after an await: it goes into the account this render drew (bound now, held across
  // the await by the handler), ❌ whichever account is signed in when it answers.
  const entry = useEntry(chatChannels, [])
  // No cloud computer (`absent`): no channels to list, and nothing to connect.
  const list = reading.state === 'value' && !('absent' in reading.value) ? reading.value : null
  return { client, reading, list, apply: (next: ChatChannelList) => { entry?.set(next) } }
}
