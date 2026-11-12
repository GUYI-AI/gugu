// GUYI-AI/gugu#2548 — the desktop left sidebar as one list (behind `interface.desktopSidebarV2`). Which conversations
// that list holds and where my own agents live, read only from data both trees already have. The shell's chat list
// (ChatListPanel) and the task page's left sidebar both import this file, so it holds no state.
import { useMemo } from 'react'
import type { ChatItem } from '@gugu/core/shared/types/chat'
import { deviceSessionsOf, useDirectoryDevices, useLiveDeviceSessions, type DeviceSessions } from '@/session/shared/remote-sessions/session-directory'
import { buildSessionTree } from '@/session/renderer/features/sessions/session-tree'
import type { SidebarPinnedAgent } from './sidebarChatsBridge'
import type { SampleProjectContent } from '@/session/renderer/features/sample-project/content/types'
import { markdownPlainText } from './markdownPlainText'

/** Where my agents live. */
export type AgentHomes = {
  /** Agent members of a group chat in the list (an ordinary group or a project group). */
  readonly inRooms: ReadonlySet<string>
  /** Agents with a session in a project on any machine (a task workspace is not a project). */
  readonly inProjects: ReadonlySet<string>
  /** Agents with a top-level task (no parent session) outside every project. */
  readonly withTopLevelTask: ReadonlySet<string>
  /** Agents pinned to the sidebar (固定到左侧栏): a pinned session of theirs lives in a group or a project. */
  readonly pinned: ReadonlySet<string>
  /** Agents whose every known session is a fork (has a parent session): a fork lives under its parent, never in the list. */
  readonly onlyForks: ReadonlySet<string>
}

/** Agent members of every group chat, project groups included. A topic is not a room of its own here. */
export function agentsInRooms(chats: readonly Pick<ChatItem, 'id' | 'kind'>[], agentsOf: (chatId: string) => readonly string[]): Set<string> {
  const agents = new Set<string>()
  for (const chat of chats) if (chat.kind === 'group') for (const agentId of agentsOf(chat.id)) agents.add(agentId)
  return agents
}

/**
 * A session is in a project when its machine lists that project as a project (`kind: 'workspace'` is the task
 * workspace; same reading as the phone's task sections). Top-level = no parent session. A fork (parent set) is never
 * top-level, also when its parent is not on any machine we can see: forks are not rows of the one list, top-level
 * tasks are (#2548 "one row per top-level task, forks stay under their parent").
 */
export function agentTaskHomes(machines: readonly Pick<DeviceSessions, 'projects' | 'sessions'>[]): Pick<AgentHomes, 'inProjects' | 'withTopLevelTask' | 'onlyForks'> {
  const inProjects = new Set<string>()
  const withTopLevelTask = new Set<string>()
  const topLevel = new Set<string>()
  const forked = new Set<string>()
  for (const { projects, sessions } of machines) {
    const realProjects = new Set(projects.filter((project) => project.kind !== 'workspace').map((project) => project.id))
    for (const session of sessions) {
      const agentId = session.agent?.userId
      if (!agentId) continue
      const inProject = realProjects.has(session.projectId)
      if (inProject) inProjects.add(agentId)
      if (session.parentConversationId) {
        forked.add(agentId)
        continue
      }
      topLevel.add(agentId)
      if (!inProject) withTopLevelTask.add(agentId)
    }
  }
  return { inProjects, withTopLevelTask, onlyForks: new Set([...forked].filter((agentId) => !topLevel.has(agentId))) }
}

/**
 * The one place an owned agent earns a row of its own: it lives in no group and no project and it is not only a fork,
 * or the user pinned it to the sidebar (固定到左侧栏), which keeps its row although it lives elsewhere.
 */
export function agentHasOwnRow(agentId: string, homes: AgentHomes): boolean {
  return homes.pinned.has(agentId) || (!homes.inRooms.has(agentId) && !homes.inProjects.has(agentId) && !homes.onlyForks.has(agentId))
}

/**
 * Does the one list show this conversation. It holds four kinds, in the list's own order (pinned first, then recent
 * activity): my standalone agents, groups, project groups, direct messages with people. Topics are never rows here.
 * `listed` = the list's existing rule for this conversation (isChatListed: an empty DM is not a conversation yet).
 * A standalone agent with a top-level task is shown before its DM has a message: that task is the conversation. So is
 * a pinned agent's pinned session (a top-level task too).
 */
export function oneListShows(
  chat: Pick<ChatItem, 'kind' | 'peer_user_id'>,
  listed: boolean,
  homes: AgentHomes,
  ownsAgent: (userId: string) => boolean,
): boolean {
  if (chat.kind === 'topic') return false
  if (chat.kind === 'group') return listed
  const peer = chat.peer_user_id
  if (!peer || !ownsAgent(peer)) return listed
  return agentHasOwnRow(peer, homes) && (listed || homes.withTopLevelTask.has(peer) || homes.pinned.has(peer))
}

/**
 * The rows at the very top of the one list, above everything else: each pinned agent's DM row, in pin order, with the
 * pin it stands for. An agent with no DM chat yet has no row; nothing is drawn in its place. `shown` = the list's rule.
 */
export function sidebarPinnedRows<C extends Pick<ChatItem, 'kind' | 'peer_user_id'>, P extends Pick<SidebarPinnedAgent, 'agentUserId'>>(
  chats: readonly C[],
  pins: readonly P[],
  shown: (chat: C) => boolean,
): { chat: C; pin: P }[] {
  const rows: { chat: C; pin: P }[] = []
  for (const pin of pins) {
    const chat = chats.find((candidate) => candidate.kind !== 'group' && candidate.kind !== 'topic' && candidate.peer_user_id === pin.agentUserId && shown(candidate))
    if (chat && !rows.some((row) => row.chat === chat)) rows.push({ chat, pin })
  }
  return rows
}

/** The list's agent homes while the one list is on; null = the list keeps today's rules. */
export function useAgentHomes(
  enabled: boolean,
  chats: readonly ChatItem[],
  membership: { readonly parts: ReadonlyMap<string, { readonly agents: readonly string[] }> },
  pins: readonly Pick<SidebarPinnedAgent, 'agentUserId'>[],
): AgentHomes | null {
  const devices = useDirectoryDevices()
  const directory = useLiveDeviceSessions()
  const tasks = useMemo(
    () => (enabled ? agentTaskHomes(devices.map((device) => deviceSessionsOf(device, directory))) : null),
    [enabled, devices, directory],
  )
  return useMemo(
    () => tasks && {
      ...tasks,
      inRooms: agentsInRooms(chats, (chatId) => membership.parts.get(chatId)!.agents),
      pinned: new Set(pins.map((pin) => pin.agentUserId)),
    },
    [tasks, chats, membership, pins],
  )
}

/**
 * Projects the one list has no conversation row for: their project group is not in the chat list (the cloud creates
 * it only when the first agent joins; until then its id is just reserved) or they have no group binding yet. These
 * keep their existing project row. `listedGroups` null = the chat list has not loaded yet; a project whose binding is
 * still being read also waits — either way say nothing rather than flash a row that is about to move.
 */
export function projectsWithoutGroupRow(
  projectIds: readonly string[],
  groupOf: (projectId: string) => string | undefined,
  bindingKnown: (projectId: string) => boolean,
  listedGroups: ReadonlySet<string> | null,
): string[] {
  if (!listedGroups) return []
  return projectIds.filter((projectId) => {
    if (!bindingKnown(projectId)) return false
    const chatId = groupOf(projectId)
    return chatId === undefined || !listedGroups.has(chatId)
  })
}

/**
 * Rows of the one list that are not a conversation yet: a local project whose project group does not exist yet, and the
 * sample project. They are drawn as conversation rows but come after every conversation row, in this order, whatever
 * their times say: the sample's times are written into it, so sorting by them would pin it to the top for everyone.
 */
export type OneListTailRow = { readonly kind: 'project'; readonly projectId: string } | { readonly kind: 'sample' }

export function oneListTail(grouplessProjects: readonly string[], sampleShown: boolean): OneListTailRow[] {
  return [
    ...grouplessProjects.map((projectId) => ({ kind: 'project' as const, projectId })),
    ...(sampleShown ? [{ kind: 'sample' as const }] : []),
  ]
}

/**
 * The sample project's row: its transcript's last message as a group row shows one, `<sender>: <text>`. The sender is
 * the sample's agent or the person looking at it (`ownerName`, the sample's other member); a task card is always theirs.
 */
export function sampleProjectLastLine(content: SampleProjectContent, ownerName: string): { readonly preview: string; readonly time: string } {
  const last = content.messages.at(-1)
  if (!last) throw new Error('the sample project has no messages')
  const sender = last.kind !== 'task' && last.from === 'agent' ? content.agent.name : ownerName
  if (last.kind !== 'file') return { preview: `${sender}: ${markdownPlainText(last.text)}`, time: last.time }
  const file = content.files.find((entry) => entry.id === last.file)
  if (!file) throw new Error(`the sample project's last message names a file it does not carry: ${last.file}`)
  return { preview: `${sender}: ${file.name}`, time: last.time }
}
