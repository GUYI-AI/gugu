import { useMemo } from 'react'
import type { ContactUser } from '@gugu/core/shared/types/contacts'
import { orderAgentContacts, useAgentRank } from './contactsAgentTree'

/** Friends and the human address book share the same people-only boundary. */
export function peopleContacts(contacts: readonly ContactUser[]): ContactUser[] {
  return contacts.filter(contact => contact.type !== 'agent')
}

/**
 * The contacts page lists my own agents only. Somebody else's agent stays reachable inside the groups it is in
 * (member lists, profile cards, pickers); on the contacts page it had no action of its own.
 */
export function myAgents(contacts: readonly ContactUser[], myId: string | null | undefined): ContactUser[] {
  return contacts.filter((contact) => contact.type === 'agent' && (!myId || !contact.owner_user_id || contact.owner_user_id === myId))
}

/** My agents in the one agent order (agent-order): the map, the agent library and search all read this list. */
export function useMyAgentsInOrder(contacts: readonly ContactUser[], myId: string | null | undefined): ContactUser[] {
  const rank = useAgentRank()
  return useMemo(() => orderAgentContacts(myAgents(contacts, myId), rank), [contacts, myId, rank])
}

/** Agent library: registered contacts plus agents encountered in shared groups, once per ID. */
export function contactAgents(contacts: readonly ContactUser[], sharedGroupAgents: readonly ContactUser[]): ContactUser[] {
  const byId = new Map<string, ContactUser>()
  for (const contact of contacts) if (contact.type === 'agent') byId.set(contact.id, contact)
  for (const agent of sharedGroupAgents) byId.set(agent.id, agent)
  return [...byId.values()]
}
