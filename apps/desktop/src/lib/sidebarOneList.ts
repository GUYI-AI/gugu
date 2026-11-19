// GUYI-AI/gugu#2548 — the desktop left sidebar as one list. Which conversations
// that list holds and where my own agents live, read only from data both trees already have. The shell's chat list
// (ChatListPanel) and the task page's left sidebar both import this file, so it holds no state.
import { useMemo, useSyncExternalStore } from 'react'
import type { ChatItem } from '@gugu/core/shared/types/chat'
import { chatDisplayName } from '@gugu/core/shared/ui/chatModels'
import { deviceSessionsOf, useDirectoryDevices, useLiveDeviceSessions, type DeviceSessions } from '@/session/shared/remote-sessions/session-directory'
import type { SidebarPinnedAgent } from './sidebarChatsBridge'
import type { OneListAgentRow } from './innerSidebarBridge'
import type { SampleProjectContent } from '@/session/renderer/features/sample-project/content/types'
import { markdownPlainText } from './markdownPlainText'
import { readArchivedGroups, subscribeArchivedGroups } from './archivedGroupsRead'

/**
 * Where my agents live (#2599): where each was created, not the groups it is a member of. Membership is one agent to
 * many groups and changes as it joins and leaves, so it cannot say where one agent is; joining a group only makes it a
 * member there.
 */
export type AgentHomes = {
  /**
   * Agents whose every top-level task lives in a group the list holds (the session's group, or a topic of it). A group
   * that is gone (dissolved, left) is no home: its agents get their own row. A top-level task in no group is reachable
   * only from the agent's own row, so that agent keeps it.
   */
  readonly inGroups: ReadonlySet<string>
  /** Agents with a top-level task (no parent session). */
  readonly withTopLevelTask: ReadonlySet<string>
  /** Agents pinned to the sidebar (固定到左侧栏): a pinned session of theirs lives in a group. */
  readonly pinned: ReadonlySet<string>
  /** Agents whose every known session is a fork (has a parent session): a fork lives under its parent, never in the list. */
  readonly onlyForks: ReadonlySet<string>
}

/**
 * #2599 The agents that live in a group the list holds: each of their top-level tasks lives (`AgentTaskHomes.groupsOf`) in
 * one of its groups, or in a topic of one (a topic is not a home of its own; it belongs to its group). One task in no
 * group, or in a group the list does not hold, keeps the agent's own row.
 */
export function agentsInGroups(
  chats: readonly Pick<ChatItem, 'id' | 'kind' | 'source_chat_id'>[],
  groupsOf: ReadonlyMap<string, ReadonlySet<string | null>>,
  gone: ReadonlySet<string>,
): Set<string> {
  const groups = new Set(chats.filter((chat) => chat.kind === 'group' && !gone.has(chat.id)).map((chat) => chat.id))
  const groupOf = new Map<string, string>()
  for (const chat of chats) if (chat.kind === 'topic' && chat.source_chat_id) groupOf.set(chat.id, chat.source_chat_id)
  const agents = new Set<string>()
  for (const [agentId, chatIds] of groupsOf) {
    if ([...chatIds].every((chatId) => chatId !== null && groups.has(groupOf.get(chatId) ?? chatId))) agents.add(agentId)
  }
  return agents
}

/** Top-level = no parent session. A fork (parent set) is never top-level, also when its parent is not on any machine we can
 * see: forks are not rows of the one list, top-level tasks are (#2548 "one row per top-level task, forks stay under their
 * parent"). */
export type AgentTaskHomes = Pick<AgentHomes, 'withTopLevelTask' | 'onlyForks'> & {
  /**
   * #2599 For each agent with a top-level task: the conversations those tasks live in — the session's group, else the
   * conversation it was created from (null = neither, or a host that does not say).
   */
  readonly groupsOf: ReadonlyMap<string, ReadonlySet<string | null>>
}

export function agentTaskHomes(machines: readonly Pick<DeviceSessions, 'sessions'>[]): AgentTaskHomes {
  const withTopLevelTask = new Set<string>()
  const forked = new Set<string>()
  const groupsOf = new Map<string, Set<string | null>>()
  for (const { sessions } of machines) {
    for (const session of sessions) {
      const agentId = session.agent?.userId
      if (!agentId) continue
      if (session.parentConversationId) {
        forked.add(agentId)
        continue
      }
      withTopLevelTask.add(agentId)
      const chats = groupsOf.get(agentId) ?? new Set<string | null>()
      // The group it works in (its folder's group); a session in no group lives where it was created (#2599).
      chats.add(session.groupChatId ?? session.bornInChatId ?? null)
      groupsOf.set(agentId, chats)
    }
  }
  return { withTopLevelTask, onlyForks: new Set([...forked].filter((agentId) => !withTopLevelTask.has(agentId))), groupsOf }
}

/**
 * The one place an owned agent earns a row of its own: it lives in no group and it is not only a fork,
 * or the user pinned it to the sidebar (固定到左侧栏), which keeps its row although it lives elsewhere.
 */
export function agentHasOwnRow(agentId: string, homes: AgentHomes): boolean {
  return homes.pinned.has(agentId) || (!homes.inGroups.has(agentId) && !homes.onlyForks.has(agentId))
}

/**
 * Does the one list show this conversation. It holds three kinds, in the list's own order (pinned first, then recent
 * activity): my standalone agents, groups, direct messages with people. Topics are never rows here.
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
 * The rows at the very top of the one list, above everything else: each pinned agent's DM row, in the order of `pins`
 * (the task page's: newest interaction first, pinnedSidebarAgents), with the pin it stands for. An agent with no DM chat yet has no row; nothing is drawn in its place. `shown` = the list's rule.
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

/**
 * #2574 My agents the one list draws as a row of their own, with what that row shows (its name before the 起名中 layer,
 * its face). `rows` = the rows the list draws (after oneListShows); a pinned agent's row (固定到左侧栏, `pinnedRows`) is
 * not one: it opens the group the agent lives in. The task page opens a standalone agent's inner column only
 * on these, so "has a row of its own" is decided here alone.
 */
export function oneListAgentRows(
  rows: readonly Pick<ChatItem, 'id' | 'kind' | 'peer_user_id' | 'name' | 'peer_alias' | 'alias'>[],
  pinnedRows: ReadonlyMap<string, unknown>,
  ownsAgent: (userId: string) => boolean,
  identities: Readonly<Record<string, { display_name?: string | null; avatar?: string | null; created_at?: string | null } | undefined>>,
): Map<string, OneListAgentRow> {
  const agents = new Map<string, OneListAgentRow>()
  for (const chat of rows) {
    const peer = chat.peer_user_id
    if ((chat.kind !== 'dm' && chat.kind !== 'ai') || !peer || !ownsAgent(peer) || pinnedRows.has(chat.id)) continue
    const identity = identities[peer]
    agents.set(peer, { chatId: chat.id, name: chatDisplayName(chat, identity?.display_name), avatar: identity?.avatar ?? null, createdAt: identity?.created_at ?? null })
  }
  return agents
}

/** The list's agent homes while the one list is on; null = the list keeps today's rules. */
export function useAgentHomes(
  enabled: boolean,
  chats: readonly ChatItem[],
  pins: readonly Pick<SidebarPinnedAgent, 'agentUserId'>[],
): AgentHomes | null {
  const devices = useDirectoryDevices()
  const directory = useLiveDeviceSessions()
  // A group read as dissolved is gone before the chat list drops it (archivedGroupsRead): its agents get their own row.
  const archivedGroups = useSyncExternalStore(subscribeArchivedGroups, readArchivedGroups)
  const tasks = useMemo(
    () => (enabled ? agentTaskHomes(devices.map((device) => deviceSessionsOf(device, directory))) : null),
    [enabled, devices, directory],
  )
  return useMemo(
    () => tasks && {
      withTopLevelTask: tasks.withTopLevelTask,
      onlyForks: tasks.onlyForks,
      inGroups: agentsInGroups(chats, tasks.groupsOf, archivedGroups),
      pinned: new Set(pins.map((pin) => pin.agentUserId)),
    },
    [tasks, chats, archivedGroups, pins],
  )
}

/**
 * Rows of the one list that are not a conversation and never stand among the conversations: a top-level task in no
 * group whose session has no 咕咕 identity (so no agent conversation stands for it), then the sample project.
 * They are drawn as conversation rows but come after every conversation row, in this order, whatever their times say:
 * the sample's times are written into it, so sorting by them would pin it to the top for everyone.
 */
export type OneListTailRow =
  | { readonly kind: 'task'; readonly projectId: string; readonly sessionId: string }
  | { readonly kind: 'sample' }

export function oneListTail(
  tasksWithoutAgent: readonly { readonly projectId: string; readonly sessionId: string }[],
  sampleShown: boolean,
): OneListTailRow[] {
  return [
    ...tasksWithoutAgent.map(({ projectId, sessionId }) => ({ kind: 'task' as const, projectId, sessionId })),
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
