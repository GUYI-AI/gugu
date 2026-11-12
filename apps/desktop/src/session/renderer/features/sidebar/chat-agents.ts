import type { AgentStatusPresentation } from '@gugu/core/shared/agentStatusPresentation';
import type { ChatAgentCounts } from '@/lib/innerSidebarBridge';
import { buildSessionTree, type SessionTreeNode } from '@renderer/features/sessions/session-tree';
import { needsYouCount, SIDEBAR_STATE_GROUP_ORDER, sidebarStateGroup } from './session-groups';
import { summarizeSessionBranches, type SessionBranchSummary } from './sidebar-session-branch';

// #2548 内层侧栏的「智能体」(群里也这么写,owner 11-12):**住在**这个群或项目里的我的会话(这台电脑与连着的机器上的,即侧栏里那些),
// 别人的智能体 ❌ 列在这里(它们在聊天和成员面板里)。项目行头像角上那个数读的是同一个推导(myAgentsInChat → chatAgentCounts)。
// #2599 住在哪按「在哪建的」定,❌ 按它此刻是哪些群的成员:成员关系一对多、随时在变,只在那个群里多一个成员。

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
  /** #2599 从哪个对话里建出来的(SessionpageSessionSummary.bornInChatId);null / 缺席 = 不是或不知道。 */
  bornInChatId?: string | null;
  /** 做完了还没看(宿主的已读位);「需要你」的计数也读它(needsYouCount)。 */
  unseen?: boolean;
  hostOnline?: boolean;
};

/**
 * 一个对话里哪些会话算「我的智能体」(#2599 住在这里的),按顶层会话定:
 *  · 它在这个项目(绑在这个项目群上的各台机器上的本地项目)里;
 *  · 或者它不在任何项目里,是在这里建的(`bornInChatId` 是这个群 / 项目群,或它们的一个话题)。
 * 只是这个群成员的 ❌ 算(它住在别处,在这里只是成员)。子会话跟着父会话走(#2548「forks stay under their parent」),
 * ❌ 按它自己的项目或来源另算一处。
 */
export type ChatAgentScope = {
  kind: 'group' | 'project';
  /** 项目:它在各台机器上的本地项目;群:[]。 */
  projectIds: readonly string[];
  /** 这个对话或它的一个话题(建在这里的 agent 住这里)。 */
  bornHere: (chatId: string) => boolean;
  /** 这个本地项目属于侧栏列着的某个项目(住在那个项目里,不在这里)。 */
  inProject: (projectId: string) => boolean;
};

function livesIn(entry: ChatAgentEntry, scope: ChatAgentScope, projects: ReadonlySet<string>): boolean {
  if (projects.has(entry.projectId)) return true;
  return !!entry.bornInChatId && scope.bornHere(entry.bornInChatId) && !scope.inProject(entry.projectId);
}

export function myAgentsInChat<T extends ChatAgentEntry>(entries: readonly T[], scope: ChatAgentScope): T[] {
  const projects = new Set(scope.projectIds);
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const decided = new Map<string, boolean>();
  // 按根定:父会话不在这一份里(另一台没连上的机器上)时,它自己就是根。
  const lives = (entry: T): boolean => {
    const known = decided.get(entry.id);
    if (known !== undefined) return known;
    decided.set(entry.id, false); // 父子成环(坏数据)时停下,❌ 无限递归
    const parent = entry.parentSessionId ? byId.get(entry.parentSessionId) : undefined;
    const answer = parent ? lives(parent) : livesIn(entry, scope, projects);
    decided.set(entry.id, answer);
    return answer;
  };
  return entries.filter(lives);
}

/**
 * #2574 侧栏里我的会话按父子编好(一遍):每条会话、每条会话的子会话(次序同 `entries`)、每个 agent 自己的顶层会话
 * (新的在前)。独立智能体那一列每次渲染都要问「这条会话是谁的」「它下面有谁」,问这一份,❌ 每问一次扫一遍。
 */
export type AgentFamilies<T extends ChatAgentEntry = ChatAgentEntry> = {
  readonly entries: readonly T[];
  readonly byId: ReadonlyMap<string, T>;
  readonly childrenOf: ReadonlyMap<string, readonly T[]>;
  readonly topLevelOf: ReadonlyMap<string, readonly T[]>;
};

export function agentFamilies<T extends ChatAgentEntry>(entries: readonly T[]): AgentFamilies<T> {
  const byId = new Map<string, T>();
  const childrenOf = new Map<string, T[]>();
  const topLevelOf = new Map<string, T[]>();
  const add = (into: Map<string, T[]>, key: string, entry: T) => {
    const list = into.get(key);
    if (list) list.push(entry);
    else into.set(key, [entry]);
  };
  for (const entry of entries) {
    byId.set(entry.id, entry);
    if (entry.parentSessionId) add(childrenOf, entry.parentSessionId, entry);
    else if (entry.agentUserId) add(topLevelOf, entry.agentUserId, entry);
  }
  for (const own of topLevelOf.values()) own.sort((a, b) => b.time - a.time);
  return { entries, byId, childrenOf, topLevelOf };
}

/**
 * #2574 一个独立智能体那一列的「智能体」:它的子智能体 —— 父会话是它自己某一条**顶层**会话的那些,连同它们往下的子会话
 * (孙辈照旧收在父会话下:chatAgentSection 按父子成家族)。它挂在别人树下的分身不是它的对话,那下面的 ❌ 算它的。
 */
export function subAgentsOf<T extends ChatAgentEntry>(families: AgentFamilies<T>, agentUserId: string): T[] {
  const found: T[] = [];
  const reached = new Set<string>();
  const queue = (families.topLevelOf.get(agentUserId) ?? []).map((entry) => entry.id);
  for (let index = 0; index < queue.length; index += 1) {
    for (const child of families.childrenOf.get(queue[index]!) ?? []) {
      if (reached.has(child.id)) continue;
      reached.add(child.id);
      found.push(child);
      queue.push(child.id);
    }
  }
  return found;
}

/** 分区头上的数与项目行角上的数:总数,与前台在跑的(同 summarizeSessionBranches:后台 / 定时的 parked 不算在跑)。 */
export function chatAgentCounts(entries: readonly Pick<ChatAgentEntry, 'presentation'>[]): ChatAgentCounts {
  return { total: entries.length, running: entries.filter((entry) => entry.presentation?.tone === 'running').length };
}

/** 分区收起时标题旁那个数:里面需要你的(同项目行那颗点、手机项目头像角标,needsYouCount)。 */
export function chatAgentNeedsYou(entries: readonly ChatAgentEntry[]): number {
  return needsYouCount(entries.map((entry) => ({ presentation: entry.presentation, unseen: entry.unseen === true, hostOnline: entry.hostOnline })));
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

/**
 * 一张平的表最多露几个家族,其余收进「展开显示 (N)」。需要你的 ❌ 收:它们多过这个数也全露,只是后面的一个都不露了。
 * 10:提议稿那一屏露 11 行(3 个要你 + 8 个),一列 32px 的行在 800px 高的窗口里摆下话题那五行之后还放得下十来行。
 */
export const CHAT_AGENT_LIMIT = 10;

export type ChatAgentList = {
  rows: ChatAgentRow[];
  /** 家族数(连收起来的)。 */
  total: number;
  /** 超出上限的家族数(0 = 没有那一行收起行;点开了也照样给,那一行这时读「收起」)。 */
  overflow: number;
};

export type ChatAgentDisclosure = {
  /** 展开着的父会话(与侧栏共用 expandedSessionIds)。 */
  expanded: ReadonlySet<string>;
  /** 「展开显示 (N)」点开了。 */
  showAll: boolean;
};

/** 需要你 → 在跑 → 其余:表里的三档(sidebarStateGroup 的次序,其余排最后)。 */
const tierOf = (entry: ChatAgentEntry): number => {
  const group = sidebarStateGroup(entry.presentation ?? null);
  return group === null ? SIDEBAR_STATE_GROUP_ORDER.length : SIDEBAR_STATE_GROUP_ORDER.indexOf(group);
};

/**
 * 分区里的行:一张平的表,❌ 组头(#2548 ⑥,刘威:「直接通过状态图标来显示……别单独分栏」)。按根会话的状态排 ——
 * 需要你的在最上面,在跑的第二层,其余在最下面;同一档里置顶的在前、再按最后交互新的在前。是哪一档只看行尾那几个记号
 * (行组件自己画:橙点要你确认、红点出错、转动的字符在跑、时钟是定时的)。子会话挂在父会话下(展开着才列出)。
 * 露 CHAT_AGENT_LIMIT 个家族,多出来的收进一行;需要你的全露。置顶的 ❌ 搬走(这一列没有「置顶」分区)。
 */
export function chatAgentSection(entries: readonly ChatAgentEntry[], disclosure: ChatAgentDisclosure): ChatAgentList {
  const forest = buildSessionTree(entries);
  const summaries = summarizeSessionBranches(forest);
  const needsYou = (entry: ChatAgentEntry) => sidebarStateGroup(entry.presentation ?? null) === 'needs-you';
  const needsAttention = (node: SessionTreeNode<ChatAgentEntry>): boolean => needsYou(node.item) || node.children.some(needsAttention);
  const roots = [...forest].sort(
    (a, b) => tierOf(a.item) - tierOf(b.item) || Number(b.item.isPinned) - Number(a.item.isPinned) || b.item.time - a.item.time
  );
  const limit = Math.max(CHAT_AGENT_LIMIT, roots.filter((root) => needsYou(root.item)).length);
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
  for (const root of disclosure.showAll ? roots : roots.slice(0, limit)) visit(root, 0);
  return { rows, total: roots.length, overflow: Math.max(0, roots.length - limit) };
}
