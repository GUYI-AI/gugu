// GUYI-AI/gugu#2548 — the desktop left sidebar as one list. Which conversations
// that list holds and where my own agents live, read only from data both trees already have. The shell's chat list
// (ChatListPanel) and the task page's left sidebar both import this file, so it holds no state.
import { reaction } from 'mobx'
import { useMemo, useSyncExternalStore } from 'react'
import type { ChatItem } from '@gugu/core/shared/types/chat'
import { chatDisplayName } from '@gugu/core/shared/ui/chatModels'
import type { AccountProject } from '@gugu/core/cloud/deviceProjects'
import { accountProjectsStore } from '@/session/renderer/features/projects/stores/account-projects-store'
import { deviceSessionsOf, useDirectoryDevices, useLiveDeviceSessions, type DeviceSessions } from '@/session/shared/remote-sessions/session-directory'
import type { SidebarPinnedAgent } from './sidebarChatsBridge'
import type { OneListAgentRow } from './innerSidebarBridge'
import type { SampleProjectContent } from '@/session/renderer/features/sample-project/content/types'
import { markdownPlainText } from './markdownPlainText'
import { readArchivedGroups, subscribeArchivedGroups } from './archivedGroupsRead'

/** Where my agents live. */
export type AgentHomes = {
  /** Agent members of a group chat in the list (an ordinary group or a project group). */
  readonly inRooms: ReadonlySet<string>
  /** Agents with a session in a project on any machine (a project of the account project list; a task workspace is none). */
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
 * Which local project is a project: the account project list holds it on that machine (`accountProject`, the one project
 * source; the task page's sidebar places sessions by the same list). `firstRead` = that list is on its first read with
 * nothing in hand: nothing can be matched yet, so meanwhile a machine's own projects count (a task workspace never does)
 * rather than list their agents as standalone rows only to move them away (as the sidebar holds those sessions back).
 */
export type ProjectReading = {
  readonly firstRead: boolean
  readonly accountProject: (deviceId: string, localProjectId: string) => boolean
}

/** The account project list read as a ProjectReading (each binding is a machine's local project in that project). */
export function accountProjectReading(list: readonly Pick<AccountProject, 'bindings'>[], firstRead: boolean): ProjectReading {
  const bound = new Set(list.flatMap((project) => project.bindings.map((binding) => `${binding.deviceId}\u0000${binding.localProjectId}`)))
  return { firstRead, accountProject: (deviceId, localProjectId) => bound.has(`${deviceId}\u0000${localProjectId}`) }
}

/**
 * A session is in a project when its machine's local project is a project (ProjectReading). Top-level = no parent
 * session. A fork (parent set) is never top-level, also when its parent is not on any machine we can see: forks are not
 * rows of the one list, top-level tasks are (#2548 "one row per top-level task, forks stay under their parent").
 */
export function agentTaskHomes(
  machines: readonly (Pick<DeviceSessions, 'projects' | 'sessions'> & { readonly deviceId: string })[],
  reading: ProjectReading,
): Pick<AgentHomes, 'inProjects' | 'withTopLevelTask' | 'onlyForks'> {
  const inProjects = new Set<string>()
  const withTopLevelTask = new Set<string>()
  const topLevel = new Set<string>()
  const forked = new Set<string>()
  for (const { deviceId, projects, sessions } of machines) {
    const ownProjects = reading.firstRead ? new Set(projects.filter((project) => project.kind !== 'workspace').map((project) => project.id)) : null
    for (const session of sessions) {
      const agentId = session.agent?.userId
      if (!agentId) continue
      const inProject = ownProjects ? ownProjects.has(session.projectId) : reading.accountProject(deviceId, session.projectId)
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
 * not one: it opens the group or project the agent lives in. The task page opens a standalone agent's inner column only
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

/** The account project list is on its first read with nothing in hand (ProjectReading.firstRead). */
const readFirstRead = () => accountProjectsStore.status === 'loading' && accountProjectsStore.projects.length === 0
const subscribeFirstRead = (listener: () => void) => reaction(readFirstRead, listener)

/** The list's agent homes while the one list is on; null = the list keeps today's rules. */
export function useAgentHomes(
  enabled: boolean,
  chats: readonly ChatItem[],
  membership: { readonly parts: ReadonlyMap<string, { readonly agents: readonly string[] }> },
  pins: readonly Pick<SidebarPinnedAgent, 'agentUserId'>[],
): AgentHomes | null {
  const devices = useDirectoryDevices()
  const directory = useLiveDeviceSessions()
  const accountList = useSyncExternalStore(accountProjectsStore.subscribe, () => accountProjectsStore.projects)
  const firstRead = useSyncExternalStore(subscribeFirstRead, readFirstRead)
  const tasks = useMemo(
    () => (enabled
      ? agentTaskHomes(
        devices.map((device) => ({ deviceId: device.device_id, ...deviceSessionsOf(device, directory) })),
        accountProjectReading(accountList, firstRead),
      )
      : null),
    [enabled, devices, directory, accountList, firstRead],
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
 * An account project (the account project list, one row per project) whose project group is not in the chat list yet:
 * it has no conversation row, so it is a row of its own. That row stands where its group's conversation row will stand:
 * among the conversation rows by the time that row will have (`activeAt`, the group's last message, else its creation;
 * chatActivityAt's projection, read from the account list), so when the conversation arrives it takes the same place.
 * Created a moment ago (a new project, whose group the account list learns of before the chat list does) = at the top.
 * Time not known yet (`activeAt` null: a list the previous client cached, before the next read) = after every row.
 * The task page draws it (setOneListProjectSlot): the chat list only says where.
 */
export type OneListProjectLine = { readonly projectChatId: string; readonly activeAt: string | null }

export const isOneListProjectLine = (row: object): row is OneListProjectLine => 'projectChatId' in row

/**
 * The account projects (archived ones are not rows) whose group is not in the chat list (`chats`, the list's whole
 * chat list: a project group the list holds but does not show is that conversation's business, as before). A local
 * project the account list does not hold is no project here (its sessions are tasks until the list holds it).
 * `archivedGroups` = the groups the chat list has read as archived (lib/archivedGroupsRead): a dissolved project leaves
 * the chat list before the account list reads the dissolve, and is no row in between (nor if that read fails).
 */
export function oneListProjectLines(
  projects: readonly Pick<AccountProject, 'chatId' | 'archived' | 'activeAt'>[],
  chats: readonly Pick<ChatItem, 'id' | 'kind'>[],
  archivedGroups: ReadonlySet<string>,
): OneListProjectLine[] {
  const groups = new Set(chats.flatMap((chat) => (chat.kind === 'group' ? [chat.id] : [])))
  return projects
    .filter((project) => !project.archived && !archivedGroups.has(project.chatId) && !groups.has(project.chatId))
    .map((project) => ({ projectChatId: project.chatId, activeAt: project.activeAt }))
}

/**
 * The conversation rows (newest activity first, `activityOf` = the list's own sort key in ms) with the project lines
 * placed among them by their time. A project line goes before the first row that is older; on an equal time after it.
 * A line whose time is not known yet goes after them all, in the account list's order.
 */
export function placeProjectLines<C>(
  rows: readonly C[],
  activityOf: (row: C) => number,
  lines: readonly OneListProjectLine[],
): (C | OneListProjectLine)[] {
  const timed = lines
    .flatMap((line) => (line.activeAt === null ? [] : [{ line, at: Date.parse(line.activeAt) }]))
    .sort((a, b) => b.at - a.at)
  const placed: (C | OneListProjectLine)[] = []
  let next = 0
  for (const row of rows) {
    const activity = activityOf(row)
    while (next < timed.length && timed[next]!.at > activity) placed.push(timed[next++]!.line)
    placed.push(row)
  }
  for (; next < timed.length; next += 1) placed.push(timed[next]!.line)
  for (const line of lines) if (line.activeAt === null) placed.push(line)
  return placed
}

const NO_PROJECT_LINES: readonly OneListProjectLine[] = []

/** The one list's project lines for the chat list (none while the one list is off). */
export function useOneListProjectLines(enabled: boolean, chats: readonly ChatItem[]): readonly OneListProjectLine[] {
  const accountList = useSyncExternalStore(accountProjectsStore.subscribe, () => accountProjectsStore.projects)
  const archivedGroups = useSyncExternalStore(subscribeArchivedGroups, readArchivedGroups)
  return useMemo(
    () => (enabled ? oneListProjectLines(accountList, chats, archivedGroups) : NO_PROJECT_LINES),
    [enabled, accountList, chats, archivedGroups],
  )
}

/**
 * Rows of the one list that are not a conversation and never stand among the conversations: a top-level task outside
 * every project whose session has no 咕咕 identity (so no agent conversation stands for it), then the sample project.
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
