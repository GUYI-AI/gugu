import type { ContactUser } from '@gugu/core/shared/types/contacts'
import { groupContacts } from '@/lib/contactsListSort'
import { contactAgents, peopleContacts } from '@/components/contacts/contactSelectors'
import { safePathSegment } from '@/session/shared/path-name'

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

/** 新群的文件夹:默认是那台机器新文件夹默认位置下、跟群同名的一个新的空文件夹。 */
export function newProjectPath(defaultDirectory: string, name: string): string {
  return `${defaultDirectory.replace(/[\\/]+$/, '')}/${name}`
}

/** 群名就是新文件夹的名字:同电脑「新建群（同时新建一个文件夹）」那一条(safePathSegment 原样认得它才行)。 */
export function projectNameProblem(name: string): 'empty' | 'invalid' | null {
  const trimmed = name.trim()
  if (!trimmed) return 'empty'
  return safePathSegment(trimmed, '') === trimmed ? null : 'invalid'
}
