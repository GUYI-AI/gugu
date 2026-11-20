import { useSyncExternalStore } from 'react'
import { computed, reaction } from 'mobx'
import type { ContactUser } from '@gugu/core/shared/types/contacts'
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
