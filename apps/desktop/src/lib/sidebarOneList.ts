// GUYI-AI/gugu#2548 — the desktop left sidebar as one list (behind `interface.desktopSidebarV2`). Which conversations
// that list holds and where my own agents live, read only from data both trees already have. The shell's chat list
// (ChatListPanel) and the task page's left sidebar both import this file, so it holds no state.
import { useMemo } from 'react'
import type { ChatItem } from '@gugu/core/shared/types/chat'
import { deviceSessionsOf, useDirectoryDevices, useLiveDeviceSessions, type DeviceSessions } from '@/session/shared/remote-sessions/session-directory'
import { buildSessionTree } from '@/session/renderer/features/sessions/session-tree'
import type { SidebarPinnedAgent } from './sidebarChatsBridge'

/** Where my agents live. */
export type AgentHomes = {
  /** Agent members of a group chat in the list (an ordinary group or a project group). */
  readonly inRooms: ReadonlySet<string>
  /** Agents with a session in a project on any machine (a task workspace is not a project). */
  readonly inProjects: ReadonlySet<string>
  /** Agents with a top-level task outside every project. */
  readonly withTopLevelTask: ReadonlySet<string>
  /** Agents pinned to the sidebar (固定到左侧栏): a pinned session of theirs lives in a group or a project. */
  readonly pinned: ReadonlySet<string>
}

/** Agent members of every group chat, project groups included. A topic is not a room of its own here. */
export function agentsInRooms(chats: readonly Pick<ChatItem, 'id' | 'kind'>[], agentsOf: (chatId: string) => readonly string[]): Set<string> {
  const agents = new Set<string>()
  for (const chat of chats) if (chat.kind === 'group') for (const agentId of agentsOf(chat.id)) agents.add(agentId)
  return agents
}

/**
 * A session is in a project when its machine lists that project as a project (`kind: 'workspace'` is the task
 * workspace; same reading as the phone's task sections). Top-level = a root of the tree built from every machine's
 * sessions (buildSessionTree, as the sidebar builds it: a fork hangs under its parent, an orphan becomes a root).
 */
export function agentTaskHomes(machines: readonly Pick<DeviceSessions, 'projects' | 'sessions'>[]): Pick<AgentHomes, 'inProjects' | 'withTopLevelTask'> {
  const inProjects = new Set<string>()
  const items = machines.flatMap(({ projects, sessions }) => {
    const realProjects = new Set(projects.filter((project) => project.kind !== 'workspace').map((project) => project.id))
    return sessions.map((session) => {
      const agentId = session.agent?.userId ?? null
      const inProject = realProjects.has(session.projectId)
      if (agentId && inProject) inProjects.add(agentId)
      return { id: session.conversationId, parentSessionId: session.parentConversationId, agentId, inProject }
    })
  })
  const withTopLevelTask = new Set<string>()
  for (const { item } of buildSessionTree(items)) if (item.agentId && !item.inProject) withTopLevelTask.add(item.agentId)
  return { inProjects, withTopLevelTask }
}

/**
 * The one place an owned agent earns a row of its own: it lives in no group and no project, or the user pinned it to
 * the sidebar (固定到左侧栏), which keeps its row although it lives elsewhere.
 */
export function agentHasOwnRow(agentId: string, homes: AgentHomes): boolean {
  return homes.pinned.has(agentId) || (!homes.inRooms.has(agentId) && !homes.inProjects.has(agentId))
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
