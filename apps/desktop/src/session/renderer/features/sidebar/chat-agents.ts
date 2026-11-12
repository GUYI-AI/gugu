import type { AgentStatusPresentation } from '@gugu/core/shared/agentStatusPresentation';
import type { ChatAgentCounts } from '@/lib/innerSidebarBridge';
import { buildSessionTree, foldIdleFamilies, type SessionTreeNode } from '@renderer/features/sessions/session-tree';
import { SIDEBAR_STATE_GROUP_ORDER, sidebarStateGroup, type SidebarStateGroup } from './session-groups';
import { summarizeSessionBranches, type SessionBranchSummary } from './sidebar-session-branch';

// #2548 内层侧栏的「我的智能体 / 智能体」:一个群或项目里**我的**会话(这台电脑与连着的机器上的,即侧栏里那些),
// 别人的智能体 ❌ 列在这里(它们在聊天和成员面板里)。项目行头像角上那个数读的是同一个推导(myAgentsInChat → chatAgentCounts)。

/** 侧栏里我的一条会话,外加它背后的那个咕咕身份(会话 → agent 的绑定,sessionAgentBindings)。 */
export type ChatAgentEntry = {
  id: string;
  projectId: string;
  parentSessionId?: string | null;
  isPinned: boolean;
  /** 最后交互时间,新的在前。 */
  time: number;
  presentation?: AgentStatusPresentation | null;
  /** 没有 = 这条会话还没有咕咕身份,不在任何对话的成员名单里。 */
  agentUserId?: string;
};

/**
 * 一个对话里哪些会话算「我的智能体」:
 *  · 群:agent 是这个群成员的那些会话;
 *  · 项目:这个项目(绑在这个项目群上的各台机器上的本地项目)的会话,加上 agent 是项目群成员的那些。
 */
export type ChatAgentScope =
  | { kind: 'group'; memberUserIds: readonly string[] }
  | { kind: 'project'; projectIds: readonly string[]; memberUserIds: readonly string[] };

export function myAgentsInChat<T extends ChatAgentEntry>(entries: readonly T[], scope: ChatAgentScope): T[] {
  const members = new Set(scope.memberUserIds);
  const projects = new Set(scope.kind === 'project' ? scope.projectIds : []);
  return entries.filter(
    (entry) => projects.has(entry.projectId) || (entry.agentUserId !== undefined && members.has(entry.agentUserId))
  );
}

/** 分区头那枚药丸与项目行角上的数:总数,与前台在跑的(同 summarizeSessionBranches:后台 / 定时的 parked 不算在跑)。 */
export function chatAgentCounts(entries: readonly Pick<ChatAgentEntry, 'presentation'>[]): ChatAgentCounts {
  return { total: entries.length, running: entries.filter((entry) => entry.presentation?.tone === 'running').length };
}

/** 同一个数画成分支计数那枚药丸(SidebarSessionBranchCount):总数 | 在跑的字形 + 个数。 */
export function chatAgentPill(entries: readonly Pick<ChatAgentEntry, 'presentation'>[]): SessionBranchSummary {
  const running = entries.flatMap((entry) => (entry.presentation?.tone === 'running' ? [entry.presentation] : []));
  return {
    total: entries.length,
    remainingDepth: 0,
    active: running.length > 0 ? [{ count: running.length, presentation: running[0] }] : [],
  };
}

export type ChatAgentRow = {
  projectId: string;
  sessionId: string;
  depth: number;
  hasChildren: boolean;
  needsAttention: boolean;
  /** 挂在父会话下的行:父会话的项目(行组件据此决定要不要标项目名)。 */
  parentProjectId?: string;
  /** 分支计数那枚药丸(子会话数、其中在跑的)。 */
  summary: SessionBranchSummary;
};

export type ChatAgentSection = {
  /** 需要你 → 运行中 → 其余(其余不带组头)。空的组不出现。 */
  groups: { group: SidebarStateGroup | null; rows: ChatAgentRow[] }[];
  /** 收进「展开显示」的闲置家族数(与项目、任务分区同一条折法)。 */
  folded: number;
};

/**
 * 分区里的行:按根会话的状态分组(需要你 / 运行中 / 其余),组内置顶的在前、再按最后交互新的在前;
 * 子会话挂在父会话下(展开着才列出,与侧栏共用 expandedSessionIds);多出来的闲置家族收进「展开显示」。
 * 与侧栏「项目」不同的一处:置顶的 ❌ 搬走(这一列没有「置顶」分区),只排在自己那一组的最前面。
 */
export function chatAgentSection(
  entries: readonly ChatAgentEntry[],
  disclosure: { expanded: ReadonlySet<string>; idleExpanded: boolean }
): ChatAgentSection {
  const forest = buildSessionTree(entries);
  const summaries = summarizeSessionBranches(forest);
  const groupOf = (entry: ChatAgentEntry) => sidebarStateGroup(entry.presentation ?? null);
  const pinnedThenNewest = (a: SessionTreeNode<ChatAgentEntry>, b: SessionTreeNode<ChatAgentEntry>) =>
    Number(b.item.isPinned) - Number(a.item.isPinned) || b.item.time - a.item.time;
  const ordered = [...SIDEBAR_STATE_GROUP_ORDER, null].flatMap((group) =>
    forest.filter((root) => groupOf(root.item) === group).sort(pinnedThenNewest)
  );
  const { shown, folded } = foldIdleFamilies(ordered, (entry) => groupOf(entry) === null, disclosure.idleExpanded);
  const needsAttention = (node: SessionTreeNode<ChatAgentEntry>): boolean =>
    groupOf(node.item) === 'needs-you' || node.children.some(needsAttention);

  const groups: ChatAgentSection['groups'] = [];
  for (const root of shown) {
    const group = groupOf(root.item);
    let bucket = groups.at(-1);
    if (!bucket || bucket.group !== group) {
      bucket = { group, rows: [] };
      groups.push(bucket);
    }
    const rows = bucket.rows;
    const visit = (node: SessionTreeNode<ChatAgentEntry>, depth: number, parentProjectId?: string) => {
      const summary = summaries.get(node.item.id);
      if (!summary) throw new Error(`Session branch summary missing for ${node.item.id}`);
      rows.push({
        projectId: node.item.projectId,
        sessionId: node.item.id,
        depth,
        hasChildren: node.children.length > 0,
        needsAttention: needsAttention(node),
        parentProjectId,
        summary,
      });
      if (!disclosure.expanded.has(node.item.id)) return;
      for (const child of node.children) visit(child, depth + 1, node.item.projectId);
    };
    visit(root, 0);
  }
  return { groups, folded };
}
