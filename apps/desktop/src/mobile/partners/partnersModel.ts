import type { ContactUser } from '@gugu/core/shared/types/contacts'
import { groupContacts } from '@/lib/contactsListSort'
import { contactAgents, peopleContacts } from '@/components/contacts/contactSelectors'

/** 朋友只列加过的人,与桌面通讯录同一个 people-only selector;群里的 Agent 另列。按读音排。 */
export function partnerFriends(contacts: readonly ContactUser[]): ContactUser[] {
  const byId = new Map(peopleContacts(contacts).map(contact => [contact.id, contact]))
  return groupContacts([...byId.values()]).flatMap((section) => section.items)
}

/** 群里遇到的 Agent:同桌面 Agent 库的数据来源,只列别人的 Agent,按读音排。 */
export function partnerGroupAgents(contacts: readonly ContactUser[], sharedGroupAgents: readonly ContactUser[], myId: string): ContactUser[] {
  return groupContacts(contactAgents(contacts, sharedGroupAgents).filter(agent => agent.owner_user_id && agent.owner_user_id !== myId))
    .flatMap(section => section.items)
}

export function matchesQuery(text: string, query: string): boolean {
  const q = query.trim().toLowerCase()
  return !q || text.toLowerCase().includes(q)
}

