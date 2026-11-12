import type { Device } from '@gugu/core/shared/types/chat'
import type { ContactGroupChat, ContactUser } from '@gugu/core/shared/types/contacts'
import type { SessionpageSessionSummary } from '@gugu/session-core/session-record/contract'
import { parseAgentStatusView } from '@gugu/core/shared/agentStatus'
import { presentAgentStatus } from '@gugu/core/shared/agentStatusPresentation'
import { displayName, groupContacts } from '@/lib/contactsListSort'
import { contactAgents, peopleContacts } from '@/components/contacts/contactSelectors'
import { safePathSegment } from '@/session/shared/path-name'
import type { AccountProject } from '@gugu/core/cloud/deviceProjects'
import type { AssistantHomeRow } from '@/lib/assistantHome'
import { phoneAccountProjects } from '../phoneAccountProjects'

/**
 * 「伙伴」里的一个项目(OpenDCAI/gugu#446):项目记在账号上、不归哪台机器(spec「项目」)。账号上的项目与各台机器上的那一份
 * 只走 phoneAccountProjects(accountProjectsStore,桌面侧栏同一份);不属于账号上任何项目的本地项目各自一行。
 */
export type PartnerProject = {
  /** 群 id;不属于账号上的项目 = `机器:本地项目`。 */
  key: string
  chatId: string | null
  name: string
  /** 最早那台建它的时间(ISO;一个文件夹都没有 = 空串,排最后):列表按它排,位置固定。 */
  createdAt: string
  /** 封面按它取色:代表的那个本地项目(同电脑侧栏那一行);一台都没有 = 群 id。 */
  coverId: string
  members: { deviceId: string; localProjectId: string }[]
}

export function partnerProjects(
  accountList: readonly AccountProject[],
  devices: readonly Device[],
  isHome: (device: AssistantHomeRow) => boolean,
): PartnerProject[] {
  const accounts = phoneAccountProjects(accountList, devices, isHome)
  const bound = new Set(accountList.flatMap((project) => project.bindings.map((binding) => `${binding.deviceId}:${binding.localProjectId}`)))
  const rows: PartnerProject[] = accounts.map(({ project, members }) => ({
    key: project.chatId,
    chatId: project.chatId,
    name: project.name,
    createdAt: members.reduce((earliest, member) => {
      const created = member.record?.createdAt ?? ''
      return created && (!earliest || created < earliest) ? created : earliest
    }, ''),
    coverId: members[0]?.localProjectId ?? project.chatId,
    members: members.map((member) => ({ deviceId: member.device.device_id, localProjectId: member.localProjectId })),
  }))
  for (const device of devices) {
    if (isHome(device)) continue
    for (const record of device.projects ?? []) {
      const key = `${device.device_id}:${record.localProjectId}`
      if (bound.has(key)) continue
      rows.push({ key, chatId: record.chatId, name: record.name, createdAt: record.createdAt, coverId: record.localProjectId, members: [{ deviceId: device.device_id, localProjectId: record.localProjectId }] })
    }
  }
  const order = (createdAt: string) => createdAt || '\uffff'
  return rows.sort((a, b) => order(a.createdAt).localeCompare(order(b.createdAt)) || a.key.localeCompare(b.key))
}

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

/** 这个项目各台机器上的会话。 */
export function projectSessions(
  project: Pick<PartnerProject, 'members'>,
  sessionsOf: (deviceId: string) => readonly SessionpageSessionSummary[],
  hostOnlineOf: (deviceId: string) => boolean | undefined = () => true,
): { deviceId: string; session: SessionpageSessionSummary; hostOnline: boolean }[] {
  return project.members.flatMap((member) => {
    const hostOnline = hostOnlineOf(member.deviceId) !== false
    return sessionsOf(member.deviceId).filter((session) => session.projectId === member.localProjectId)
      .map((session) => ({ deviceId: member.deviceId, session, hostOnline }))
  })
}

export type ProjectAgent = {
  id: string
  /** 通讯录里还没有它(刚开出来)= null,名字用它在做的事。 */
  contact: ContactUser | null
  /** 它在这个项目里最近做的那件事。 */
  work: string | null
  /** 那件事的会话(点这一行打开它);只在群里、这个项目里还没有会话 = null。 */
  latest: { deviceId: string; session: SessionpageSessionSummary } | null
}

/** 点项目通讯录里一个 agent 去哪:它在这里有会话 ⇒ 那条会话自己的页;没有 ⇒ 项目群。 */
export type ProjectAgentTarget =
  | { kind: 'session'; deviceId: string; session: SessionpageSessionSummary }
  | { kind: 'group' }

/**
 * owner 10-28 手机试用:「在伙伴 项目里选择一个会话 居然不是会话聊天页 而是群聊页 加@」。
 * 一个 agent 一行,行上写的是它在这里最近那件事 —— 点它就进那条会话,❌ 进项目群。
 */
export function projectAgentTarget(agent: Pick<ProjectAgent, 'latest'>): ProjectAgentTarget {
  return agent.latest ? { kind: 'session', deviceId: agent.latest.deviceId, session: agent.latest.session } : { kind: 'group' }
}

/**
 * 项目通讯录「Agent」:我在这个项目里的 agent —— 项目群里我的 agent,加上这个项目的会话里有、群里还没有的。
 * 顺序固定(群里的先后,再是会话里多出来的),❌ 按状态排;副标题是它在这里最近那件事的标题,点它打开那条会话。
 */
export function projectAgents(
  group: Pick<ContactGroupChat, 'member_user_ids'> | null,
  myAgents: ReadonlyMap<string, ContactUser>,
  sessions: readonly { deviceId: string; session: SessionpageSessionSummary }[],
): ProjectAgent[] {
  const latest = new Map<string, { deviceId: string; session: SessionpageSessionSummary }>()
  for (const row of sessions) {
    const agentId = row.session.agent?.userId
    if (!agentId) continue
    const seen = latest.get(agentId)
    if (!seen || (row.session.lastInteractedAt ?? '') > (seen.session.lastInteractedAt ?? '')) latest.set(agentId, row)
  }
  const ids = [...(group?.member_user_ids ?? []).filter((id) => myAgents.has(id))]
  for (const { session } of sessions) {
    const agentId = session.agent?.userId
    if (agentId && !ids.includes(agentId)) ids.push(agentId)
  }
  return ids.map((id) => {
    const row = latest.get(id) ?? null
    return { id, contact: myAgents.get(id) ?? null, work: row?.session.title ?? null, latest: row }
  })
}

export function agentName(agent: ProjectAgent): string {
  return agent.contact ? displayName(agent.contact) : agent.work ?? agent.id
}

/** 封面的鲜灰:这个项目此刻有几个 agent 在干活。 */
export function runningCount(sessions: readonly { session: SessionpageSessionSummary; hostOnline?: boolean }[]): number {
  return sessions.filter(({ session, hostOnline }) => {
    const status = presentAgentStatus({ reading: parseAgentStatusView(session.status ?? null), hostOnline: hostOnline !== false })
    return status?.tone === 'running' || status?.tone === 'parked'
  }).length
}

/** 新项目的文件夹:默认是那台机器默认项目目录下、跟项目同名的一个新的空文件夹。 */
export function newProjectPath(defaultDirectory: string, name: string): string {
  return `${defaultDirectory.replace(/[\\/]+$/, '')}/${name}`
}

/** 项目名就是新文件夹的名字:同电脑「新建项目」那一条(safePathSegment 原样认得它才行)。 */
export function projectNameProblem(name: string): 'empty' | 'invalid' | null {
  const trimmed = name.trim()
  if (!trimmed) return 'empty'
  return safePathSegment(trimmed, '') === trimmed ? null : 'invalid'
}
