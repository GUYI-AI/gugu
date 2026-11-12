import type { AgentStatusPresentation } from '@gugu/core/shared/agentStatusPresentation';
import type { ChatAgentCounts } from '@/lib/innerSidebarBridge';
import { buildSessionTree, type SessionTreeNode } from '@renderer/features/sessions/session-tree';
import { needsYouCount, SIDEBAR_STATE_GROUP_ORDER, sidebarStateGroup, type SidebarStateGroup } from './session-groups';
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
  /** 做完了还没看(宿主的已读位);「需要你」的计数也读它(needsYouCount)。 */
  unseen?: boolean;
  hostOnline?: boolean;
  /** 会话名(找的时候按它匹配)。 */
  title?: string;
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

/** 分区收起时标题旁那个数:里面需要你的(同项目行那颗点、手机项目头像角标,needsYouCount)。 */
export function chatAgentNeedsYou(entries: readonly ChatAgentEntry[]): number {
  return needsYouCount(entries.map((entry) => ({ presentation: entry.presentation, unseen: entry.unseen === true, hostOnline: entry.hostOnline })));
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

/** 正在找时这一分区有没有命中的(名字含这几个字的会话)。 */
export function chatAgentsMatch(entries: readonly ChatAgentEntry[], query: string): boolean {
  const needle = query.trim().toLocaleLowerCase();
  return entries.some((entry) => (entry.title ?? '').toLocaleLowerCase().includes(needle));
}

/** 运行中最多露几个家族,其余收进「还有 N 个在运行」。 */
export const CHAT_AGENT_RUNNING_LIMIT = 5;
/** 其余(空闲)最多露几个家族,其余收进「展开显示 (N)」。 */
export const CHAT_AGENT_REST_LIMIT = 3;

export type ChatAgentGroup = {
  /** 需要你 / 运行中 / 其余(null,不带组头)。 */
  group: SidebarStateGroup | null;
  rows: ChatAgentRow[];
  /** 这一组的家族数(连收起来的),组头上那个数。 */
  total: number;
  /** 超出上限的家族数(0 = 没有那一行收起行;点开了也照样给,那一行这时读「收起」)。需要你、在找时永远是 0。 */
  overflow: number;
};

export type ChatAgentDisclosure = {
  /** 展开着的父会话(与侧栏共用 expandedSessionIds)。 */
  expanded: ReadonlySet<string>;
  /** 「还有 N 个在运行」点开了。 */
  showAllRunning: boolean;
  /** 「展开显示 (N)」点开了。 */
  showAllRest: boolean;
  /** 正在找的字(空 = 没在找)。在找时只留命中的家族(它自己或它下面某条的名字含这几个字),❌ 再收起任何一个。 */
  query?: string;
};

/**
 * 分区里的行:按根会话的状态分组(需要你 → 运行中 → 其余),组内置顶的在前、再按最后交互新的在前;
 * 子会话挂在父会话下(展开着才列出)。需要你的全露;运行中露 5 个家族、其余露 3 个,多出来的各收进一行。
 * 置顶的 ❌ 搬走(这一列没有「置顶」分区),只排在自己那一组的最前面。空的组不出现。
 */
export function chatAgentSection(entries: readonly ChatAgentEntry[], disclosure: ChatAgentDisclosure): ChatAgentGroup[] {
  const forest = buildSessionTree(entries);
  const summaries = summarizeSessionBranches(forest);
  const groupOf = (entry: ChatAgentEntry) => sidebarStateGroup(entry.presentation ?? null);
  const query = disclosure.query?.trim().toLocaleLowerCase() ?? '';
  const hits = (node: SessionTreeNode<ChatAgentEntry>): boolean =>
    (node.item.title ?? '').toLocaleLowerCase().includes(query) || node.children.some(hits);
  const pinnedThenNewest = (a: SessionTreeNode<ChatAgentEntry>, b: SessionTreeNode<ChatAgentEntry>) =>
    Number(b.item.isPinned) - Number(a.item.isPinned) || b.item.time - a.item.time;
  const needsAttention = (node: SessionTreeNode<ChatAgentEntry>): boolean =>
    groupOf(node.item) === 'needs-you' || node.children.some(needsAttention);
  const limitOf = (group: SidebarStateGroup | null): number =>
    query || group === 'needs-you' ? Number.POSITIVE_INFINITY : group === 'working' ? CHAT_AGENT_RUNNING_LIMIT : CHAT_AGENT_REST_LIMIT;
  const showsAll = (group: SidebarStateGroup | null): boolean =>
    group === 'working' ? disclosure.showAllRunning : group === null ? disclosure.showAllRest : true;

  const groups: ChatAgentGroup[] = [];
  for (const group of [...SIDEBAR_STATE_GROUP_ORDER, null]) {
    const roots = forest
      .filter((root) => groupOf(root.item) === group && (!query || hits(root)))
      .sort(pinnedThenNewest);
    if (roots.length === 0) continue;
    const limit = limitOf(group);
    const rows: ChatAgentRow[] = [];
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
    const overflow = Math.max(0, roots.length - limit);
    for (const root of showsAll(group) ? roots : roots.slice(0, limit)) visit(root, 0);
    groups.push({ group, rows, overflow, total: roots.length });
  }
  return groups;
}
