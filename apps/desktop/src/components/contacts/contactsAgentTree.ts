import { useSyncExternalStore } from 'react'
import { comparer, computed, reaction } from 'mobx'
import type { ContactUser } from '@gugu/core/shared/types/contacts'
import { orderAgentRows } from '@renderer/features/sidebar/agent-order'
import type { ChatAgentEntry } from '@renderer/features/sidebar/chat-agents'
import { sidebarFamilies } from '@renderer/features/sidebar/inner-sidebar-scope'

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

// 通讯录里 agent 的次序 = 侧栏「智能体」同一个(agent-order):一个 agent 按它最近交互的那条会话排。
// 次序真变了才换身份(comparer.structural):状态跳一下、次序没变,通讯录 ❌ 重画。
const agentRank = computed(() => {
  const latest = new Map<string, ChatAgentEntry>()
  for (const entry of sidebarFamilies.get().entries) {
    if (!entry.agentUserId) continue
    const known = latest.get(entry.agentUserId)
    if (!known || entry.time > known.time) latest.set(entry.agentUserId, entry)
  }
  return orderAgentRows([...latest.values()]).map((entry) => entry.agentUserId!)
}, { keepAlive: true, equals: comparer.structural })

const subscribeRank = (onChange: () => void) => reaction(() => agentRank.get(), onChange)
const rankSnapshot = () => agentRank.get()

/** 我的 agent 的次序(agent 身份,排好的)。 */
export function useAgentRank(): readonly string[] {
  return useSyncExternalStore(subscribeRank, rankSnapshot)
}

const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

/** 按 `rank` 排;侧栏里没有会话的(别人的 agent,或会话在看不到的机器上)排在后面,按建的先后、再按 id。 */
export function orderAgentContacts(agents: readonly ContactUser[], rank: readonly string[]): ContactUser[] {
  const at = new Map(rank.map((id, index) => [id, index]))
  const place = (agent: ContactUser) => at.get(agent.id) ?? rank.length
  return [...agents].sort((a, b) => place(a) - place(b) || byText(a.created_at ?? '', b.created_at ?? '') || byText(a.id, b.id))
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
