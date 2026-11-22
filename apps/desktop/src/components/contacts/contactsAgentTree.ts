import { useSyncExternalStore, type DragEvent } from 'react'
import { computed, reaction } from 'mobx'
import type { ContactUser } from '@gugu/core/shared/types/contacts'
import { moveSessionUnder } from '@renderer/features/sessions/set-session-parent-flow'
import type { ChatAgentEntry } from '@renderer/features/sidebar/chat-agents'
import { sidebarFamilies } from '@renderer/features/sidebar/inner-sidebar-scope'
import { nestVerdict, sessionDropTarget } from '@renderer/features/sidebar/session-drop-target'
import { clearDraggedScreenContent, getDraggedScreenContent, setDraggedScreenContent } from '@renderer/lib/drag-screen-content'
import { sidebarStore } from '@renderer/lib/stores/app-state'

// 通讯录里一个设备段的 agent 按「谁派生了谁」画成树。父子这条边 ❌ 另存一份:就是侧栏建树用的那条
// (会话的 parentSessionId,跨机器的是 parentConversationId),经 sidebarFamilies 拿到;会话 → agent 身份走同一份绑定。
// 一个 agent 有多条会话时,按它最新那条顶层会话之外的会话认父 —— 只要它有一条会话挂在别人下面,它就是那个人的子 agent。

export type AgentTreeNode = { contact: ContactUser; depth: number; children: AgentTreeNode[]; last: boolean }

/** agent 身份 → 父 agent 身份(只认两端都是我侧栏里有的会话)。 */
function parentAgentMap(): ReadonlyMap<string, string> {
  const { entries, byId } = sidebarFamilies.get()
  const out = new Map<string, string>()
  for (const entry of entries) {
    if (!entry.agentUserId || !entry.parentSessionId || out.has(entry.agentUserId)) continue
    const parent = byId.get(entry.parentSessionId)?.agentUserId
    if (parent && parent !== entry.agentUserId) out.set(entry.agentUserId, parent)
  }
  return out
}

// 侧栏会话变了才重算一次;身份不变 = 没变(useSyncExternalStore 靠它判断要不要重画)。
const parentAgents = computed(parentAgentMap, { keepAlive: true })

const subscribe = (onChange: () => void) => reaction(() => parentAgents.get(), onChange)
const snapshot = () => parentAgents.get()

export function useAgentParents(): ReadonlyMap<string, string> {
  return useSyncExternalStore(subscribe, snapshot)
}

/** 一段里的 agent 成树:父不在这一段里(在别的设备上)就自己当根。次序沿用传进来的(置顶在前)。 */
export function buildAgentForest(agents: readonly ContactUser[], parents: ReadonlyMap<string, string>): AgentTreeNode[] {
  const here = new Set(agents.map((agent) => agent.id))
  const kids = new Map<string, ContactUser[]>()
  const roots: ContactUser[] = []
  for (const agent of agents) {
    const parent = parents.get(agent.id)
    if (parent && here.has(parent)) kids.set(parent, [...(kids.get(parent) ?? []), agent])
    else roots.push(agent)
  }
  const seen = new Set<string>()
  const grow = (list: ContactUser[], depth: number): AgentTreeNode[] =>
    list.filter((agent) => !seen.has(agent.id) && seen.add(agent.id)).map((contact, index, all) => ({
      contact, depth, last: index === all.length - 1, children: grow(kids.get(contact.id) ?? [], depth + 1),
    }))
  const forest = grow(roots, 0)
  // 父子成环(坏数据)时环里谁都不是根:剩下的各自当根,❌ 从通讯录里消失。
  return [...forest, ...grow(agents.filter((agent) => !seen.has(agent.id)), 0)]
}

export function flattenForest(forest: readonly AgentTreeNode[]): AgentTreeNode[] {
  return forest.flatMap((node) => [node, ...flattenForest(node.children)])
}

// 通讯录里拖 agent 编排父子 = 侧栏里拖会话(同一个 moveSessionUnder,同一份拖拽数据、同一个 nestVerdict):节点只是把 agent
// 换成它的那条会话。拖的是它画在父下面的那条(挂在别人下面的那条),没有就是它最新的顶层会话;挂到一个 agent 下面 = 挂到
// 它最新的顶层会话下面(它只有挂在别人下面的会话时,挂到那条下面)。会话在事件那一刻才查(节点 ❌ 为此订阅侧栏)。
function sessionToDrag(agentUserId: string): ChatAgentEntry | null {
  const { entries, topLevelOf } = sidebarFamilies.get()
  return entries.find((entry) => entry.agentUserId === agentUserId && entry.parentSessionId) ?? topLevelOf.get(agentUserId)?.[0] ?? null
}

function sessionToNestUnder(agentUserId: string): ChatAgentEntry | null {
  const { entries, topLevelOf } = sidebarFamilies.get()
  return topLevelOf.get(agentUserId)?.[0] ?? entries.find((entry) => entry.agentUserId === agentUserId) ?? null
}

/**
 * agent 节点的拖与放:拖起 = 拖它的会话(只有自己的 agent 拖得起);落在它上面 = 挂到它下面,挂不上的就地说为什么。
 * 节点在「回到顶层」那块里面:拖着会话经过节点,这件事归节点 —— 连它不收的(拖到它自己上)也 ❌ 冒到外面那块,
 * 不然在自己身上松手会把自己挪回顶层。
 */
export function agentNodeDrag(agentUserId: string, name: string, mine: boolean) {
  const drop = sessionDropTarget(
    (dragged) => {
      const target = sessionToNestUnder(agentUserId)
      return target ? nestVerdict(dragged, { sessionId: target.id, title: name }) : false
    },
    (child) => {
      const target = sessionToNestUnder(agentUserId)
      if (target) moveSessionUnder(child, { projectId: target.projectId, sessionId: target.id, title: name }, sidebarStore.parentOf(child.sessionId))
    }
  )
  const own = (handle: (event: DragEvent<HTMLElement>) => void) => (event: DragEvent<HTMLElement>) => {
    if (getDraggedScreenContent(event.dataTransfer)?.kind === 'session') event.stopPropagation()
    handle(event)
  }
  return {
    draggable: mine,
    onDragStart: (event: DragEvent<HTMLElement>) => {
      const session = sessionToDrag(agentUserId)
      if (!session) return event.preventDefault()
      setDraggedScreenContent(event.dataTransfer, { kind: 'session', sessionId: session.id, projectId: session.projectId, title: name }, event.currentTarget)
    },
    onDragEnd: clearDraggedScreenContent,
    onDragOver: own(drop.onDragOver),
    onDragLeave: drop.onDragLeave,
    onDrop: own(drop.onDrop),
  }
}

/** 落在 agent 区的空白处或「智能体」标题上 = 回到顶层(同侧栏「智能体」分区头)。 */
export const agentFamiliesUnnest = sessionDropTarget(
  (dragged) => nestVerdict(dragged, null),
  (child) => moveSessionUnder(child, null, sidebarStore.parentOf(child.sessionId))
)
