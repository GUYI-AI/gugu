import { computed, makeAutoObservable, observable, onBecomeObserved, onBecomeUnobserved, type IComputedValue } from 'mobx';
import {
  buildSessionTree,
  familiesByRoot,
  type SessionTreeNode,
} from '@renderer/features/sessions/session-tree';
import { type ProjectStore } from '@renderer/features/projects/stores/project';
import type { ProjectManagerStore } from '@renderer/features/projects/stores/project-manager';
import { pageSessions } from '@renderer/features/sessions/stores/session-selectors';
import { isWorkspaceProject } from '@renderer/features/sessions/session-home-project-constants';
import type { Snapshottable } from '@renderer/lib/stores/snapshottable';
import type { SidebarSnapshot, SidebarSessionSortBy } from '@shared/view-state';
import type { JoinedGroup } from '@/lib/sidebarJoinedGroups';
import type { SessionpageSessionSummary } from '@gugu/session-core/session-record/contract';
import { isAssistantAgent, isAssistantSession, launchedByAssistant } from '@renderer/features/assistant/assistant-lineage';
import { taskPresentation } from '@/lib/taskAgentStatus';
import type { AgentStatusView } from '@gugu/core/shared/agentStatus';
import type { AgentStatusPresentation } from '@gugu/core/shared/agentStatusPresentation';
import { sessionPresentation } from '@/mobile/agent-watch/watch-status';
import { sessionAgentBindings } from '@renderer/features/sessions/stores/session-agent-bindings';
import { accountProjectsStore, type AccountProjectsStore } from '@renderer/features/projects/stores/account-projects-store';
import { sidebarStateGroup, type SidebarStateGroup } from './session-groups';

function parseSidebarSessionSortBy(value: unknown): SidebarSessionSortBy | undefined {
  return value === 'created-at' || value === 'updated-at' ? value : undefined;
}

/**
 * behavior session-page「键盘导航」: a station of the keyboard navigation — the New task entry, a project row (= that
 * project's home, where a new session is started) or a conversation. Section titles and state-group titles are not
 * stations.
 */
export type SidebarNavNode =
  | { kind: 'new-session' }
  | { kind: 'project'; projectId: string }
  | { kind: 'conversation'; projectId: string; sessionId: string };

/** 「任务」分区在 placement 里的键(项目行用项目 id)。 */
const SESSIONS_SECTION = '\u0000sessions';

type SidebarSessionEntry = {
  id: string;
  projectId: string;
  sessionId: string;
  parentSessionId?: string | null;
  isPinned: boolean;
  time: number;
  group: SidebarStateGroup | null;
  presentation?: AgentStatusPresentation | null;
  /** The host's read bit: a read failure stays in its group but leaves the counts (isNeedsYou). */
  unseen: boolean;
  hostOnline?: boolean;
  /** Raw addressing name; components decide how to display it. */
  title: string;
  createdAt?: string;
};

/**
 * 「项目」分区里的一项 = 账号上的一个项目(accountProjectsStore)。项目表里有它的本地项目(哪台机器上的都算):
 * 行 id = 代表那一个(groupRowOrder),navigate('project')、项目块照旧认它;一个都没有(哪台上都没有文件夹,
 * 或文件夹只在还没载入的机器上):行 id = 项目群,点开是项目群。
 */
export type SidebarProjectRef =
  | { kind: 'local'; id: string; chatId: string; name: string; activeAt: string | null; project: ProjectStore }
  | { kind: 'group'; id: string; chatId: string; name: string; activeAt: string | null };

/** #6264 侧栏要知道的机器读数(由 remoteHostsStore 注入;不注入 = 全是本机,单测默认如此)。 */
export type SidebarMachines = {
  machineOf(projectId: string): string | null;
  label(deviceId: string): string | null;
  homeDir(deviceId: string): string | null;
  /**
   * 那台机器上有哪些会话(会话目录,与手机同一份)。别的机器上的行只读它,❌ 读挂载的项目:列出不挂载,
   * 打开就先画上次的样子。`live` 只说明目录连接；Agent 工作态由共享 presence 提供。
   */
  sessionsOf?(deviceId: string): { sessions: readonly SessionpageSessionSummary[]; live: boolean };
  /** 同一份目录里的一条(按会话 id)。 */
  session?(deviceId: string, conversationId: string): SessionpageSessionSummary | null;
  /** #7199 这台是不是个人助理住的那台(它上面的项目并成一组,组名是它的名字)。 */
  isAssistantHome?(deviceId: string): boolean;
  /** 那台机器此刻连着(一个项目由谁画,行落在连着的那台上,见 groupRowOrder)。 */
  connected?(deviceId: string): boolean;
};

/** 一条别的机器上的会话(侧栏远程行画它)。 */
export type RemoteSidebarSession = { summary: SessionpageSessionSummary; live: boolean };

/** 这台机器上挂着的一条会话画成什么:与列出的会话同一个 `taskPresentation`。 */
export function mountedSessionPresentation(
  session: { data: { id: string }; status: AgentStatusView['status'] | null; detail: AgentStatusView['detail']; seen: boolean },
  agentUserId = sessionAgentBindings.bindingFor(session.data.id)?.agentUserId,
): AgentStatusPresentation | null {
  return taskPresentation({ agentUserId, reading: session.status ? { status: session.status, detail: session.detail } : null, unseen: !session.seen, hostOnline: true });
}

export class SidebarStore implements Snapshottable<SidebarSnapshot> {
  projectOrder: string[] = [];
  sessionOrderByProject: Record<string, string[]> = {};
  expandedProjectIds = observable.set<string>();
  /** Persisted manual "Show more" state: project id or the Tasks section key. */
  idleExpandedProjectIds = observable.set<string>();
  /** Persisted disclosure state for parent/child conversation trees. */
  expandedSessionIds = observable.set<string>();
  /**
   * 指针压到会话行上时,这一行要不要就地变成它的 agent 名字(#5818)。设置
   * `interface.showLeftSidebarAgentNameOnHover` 的镜像,由 left-sidebar 同步进来:
   * ❌ 不在每一行里各调一次设置 hook(侧栏是几十行的场面)。
   */
  agentNameOnHoverEnabled = true;
  sessionSortBy: SidebarSessionSortBy = 'created-at';
  /**
   * #6264 项目在哪台机器、那台机器叫什么、主目录在哪。由机器那边注入(remoteHostsStore.start),
   * 排版逻辑因此能脱离桥单测。搜索时机器名也算项目名的一部分。
   */
  machines: SidebarMachines | null = null;
  /** 拼在一屏的几组(这屏那边注入,screen-layout-actions;不注入 = 没有组,单测默认如此)。 */
  joinedGroups: readonly JoinedGroup[] = [];
  /**
   * #7199 个人助理是谁(它的 agent id,壳按库里的标记认出来、由 left-sidebar 同步进来;没有 = null)。
   * owner:「它不应该生活在任务区」—— 它自己的会话不进这里的任何列表;它派出来的照常在,行上标「助理发起」。
   */
  assistantAgentId: string | null = null;
  constructor(
    private readonly projectManager: ProjectManagerStore,
    /** 账号上的项目:「项目」分区只列它们(❌ 再按项目群拼本地项目)。 */
    readonly accountProjects: AccountProjectsStore = accountProjectsStore,
  ) {
    makeAutoObservable<SidebarStore, 'remoteEntryById' | 'projectManager' | 'accountProjects'>(this, {
      remoteEntryById: false,
      projectManager: false,
      accountProjects: false,
      machines: observable.ref,
      joinedGroups: observable.ref,
      expandedProjectIds: false,
      idleExpandedProjectIds: false,
      expandedSessionIds: false,
    });

  }

  /** 「项目」分区里画得出本地项目的那些行的代表(本机与别的机器上的,按侧栏次序)。 */
  get orderedProjects(): ProjectStore[] {
    return this.sidebarProjects.flatMap((ref) => (ref.kind === 'local' ? [ref.project] : []));
  }

  /**
   * 「项目」分区的次序:本机项目与别的机器上的项目混排(#6264,按 Zed)。手动拖过之后按 `projectOrder` 排;
   * 还没进手动次序的新项目排最前(新建即可见)。
   */
  get sidebarProjects(): SidebarProjectRef[] {
    // 一个账号项目一行(归档的不列)。项目表里没有对应项目的本地项目(#609 workspace 等)不成行,会话在「任务」里。
    const all: SidebarProjectRef[] = this.accountProjects.projects
      .filter((account) => !account.archived)
      .map((account): SidebarProjectRef => {
        const id = this.accountProjects.representativeOf(account.chatId);
        const project = id ? this.projectManager.projects.get(id) : undefined;
        return project
          ? { kind: 'local', id: project.id, chatId: account.chatId, name: account.name || (project.name ?? ''), activeAt: account.activeAt, project }
          : { kind: 'group', id: account.chatId, chatId: account.chatId, name: account.name, activeAt: account.activeAt };
      })
      .sort((a, b) => this.compareSidebarProjects(a, b));
    if (this.projectOrder.length === 0) return all;
    const rank = (ref: SidebarProjectRef, index: number): [number, number] => {
      const manual = this.projectOrder.indexOf(ref.id);
      return manual !== -1 ? [1, manual] : [0, index];
    };
    return all
      .map((ref, index) => ({ ref, rank: rank(ref, index) }))
      .sort((a, b) => a.rank[0] - b.rank[0] || a.rank[1] - b.rank[1])
      .map(({ ref }) => ref);
  }

  /** 这一行代表的项目在各台机器上的本地项目(代表行在最前);不属于账号上任何项目 = 只有它自己。 */
  projectMembersOf(rowId: string): readonly string[] {
    const chatId = this.accountProjects.projectOfLocal(rowId)?.chatId;
    return chatId ? this.accountProjects.membersOf(chatId) : [rowId];
  }

  /** 这一行的项目名(账号上的项目名 = 项目群名)。 */
  projectRowName(rowId: string): string | null {
    return this.sidebarProjects.find((ref) => ref.id === rowId)?.name ?? null;
  }

  /** 这个本地项目的会话显示在哪一行下:它所属账号项目的那一行;不属于任何项目 = 它自己。 */
  rowProjectIdOf(projectId: string): string {
    const chatId = this.accountProjects.projectOfLocal(projectId)?.chatId;
    return (chatId && this.accountProjects.representativeOf(chatId)) || projectId;
  }

  /** 会话所在项目行的名字(侧栏里那一行怎么写,它就怎么写)。 */
  projectLabel(projectId: string): string | null {
    // #609 workspace 等不属于账号项目的,没有项目名可标。
    return this.accountProjects.projectOfLocal(projectId) ? this.projectRowName(this.rowProjectIdOf(projectId)) : null;
  }

  /** 挂在父会话下的行要标的项目名:与父会话不在同一个项目行时才有(与机器标记同一条「跟上面那一行比」)。 */
  nestedProjectLabel(projectId: string, parentProjectId: string): string | null {
    return this.rowProjectIdOf(projectId) === this.rowProjectIdOf(parentProjectId) ? null : this.projectLabel(projectId);
  }

  /**
   * 每条会话显示在哪一行下(项目行,或「任务」分区):一家子跟着根会话那一行走。别的机器上的 agent 可以挂在本机的
   * 会话下面,反过来也一样(owner 2026-10-01),所以各行与「任务」分区的会话合起来建一次树,再按根分回去。
   * 本机的 child 与父会话同一个工作目录,本来就在同一行。
   */
  get placement(): {
    entries: ReadonlyMap<string, SidebarSessionEntry[]>;
    rowOfSession: ReadonlyMap<string, string>;
    nodeById: ReadonlyMap<string, SessionTreeNode<SidebarSessionEntry>>;
  } {
    const home = new Map<string, string>();
    const all: SidebarSessionEntry[] = [];
    const collect = (rowId: string, entries: SidebarSessionEntry[]) => {
      for (const entry of entries) home.set(entry.id, rowId);
      all.push(...entries);
    };
    for (const ref of this.sidebarProjects) collect(ref.id, this.rowOwnEntries(ref.chatId));
    collect(SESSIONS_SECTION, this.standaloneOwnEntries());
    const entries = new Map<string, SidebarSessionEntry[]>();
    const rowOfSession = new Map<string, string>();
    const place = (node: SessionTreeNode<SidebarSessionEntry>, rowId: string) => {
      const list = entries.get(rowId);
      if (list) list.push(node.item);
      else entries.set(rowId, [node.item]);
      if (!rowOfSession.has(node.item.sessionId)) rowOfSession.set(node.item.sessionId, rowId);
      for (const child of node.children) place(child, rowId);
    };
    const forest = buildSessionTree(all);
    const nodeById = new Map<string, SessionTreeNode<SidebarSessionEntry>>();
    const index = (node: SessionTreeNode<SidebarSessionEntry>) => {
      nodeById.set(node.item.id, node);
      for (const child of node.children) index(child);
    };
    for (const root of forest) index(root);
    for (const [rowId, roots] of familiesByRoot(forest, (root) => home.get(root.id)!))
      for (const root of roots) place(root, rowId);
    for (const list of entries.values()) list.sort((a, b) => b.time - a.time);
    return { entries, rowOfSession, nodeById };
  }

  setJoinedGroups(groups: readonly JoinedGroup[]): void {
    this.joinedGroups = groups;
  }

  /** 这条会话此刻挂在谁下面(侧栏建树的那条边);根 / 侧栏里没有 = null。 */
  parentOf(sessionId: string): string | null {
    return this.placement.nodeById.get(sessionId)?.item.parentSessionId ?? null;
  }

  /** `sessionId` 就是 `ancestorId`,或挂在它下面(往上走父会话那条边):把 ancestor 挂到它下面会成环。 */
  isWithin(sessionId: string, ancestorId: string): boolean {
    const seen = new Set<string>();
    for (let at: string | null = sessionId; at && !seen.has(at); at = this.parentOf(at)) {
      if (at === ancestorId) return true;
      seen.add(at);
    }
    return false;
  }

  /**
   * 这项任务的会话显示在哪一行下:项目行 id,「任务」分区为 null。不在列表里的(归档的、还没载入的)按它的项目算。
   */
  rowOfSession(projectId: string, sessionId: string): string | null {
    const placed = this.placement.rowOfSession.get(sessionId);
    if (placed !== undefined) return placed === SESSIONS_SECTION ? null : placed;
    const row = this.rowProjectIdOf(projectId);
    return this.isTasksProject(this.projectManager.projects.get(projectId) ?? { id: projectId }) ? null : row;
  }

  /**
   * #2548 top-level tasks outside every project whose session has no 咕咕 identity (never driven, or an engine that cannot be
   * addressed), newest first. The one list draws a standalone task as its agent's conversation; these have none, so each
   * is a row of its own (oneListTail). This machine's identities not read yet = none, rather than rows about to move.
   */
  get tasksWithoutAgent(): { projectId: string; sessionId: string }[] {
    if (!sessionAgentBindings.isLoaded) return [];
    return (this.placement.entries.get(SESSIONS_SECTION) ?? [])
      .filter(
        (entry) =>
          !entry.parentSessionId &&
          !sessionAgentBindings.bindingFor(entry.id) &&
          !this.remoteSession(entry.projectId, entry.id)?.summary.agent?.userId
      )
      .map(({ projectId, id }) => ({ projectId, sessionId: id }));
  }

  /** 一行自己的会话:这个项目在各台机器上的本地项目里的(membersOf)。 */
  private rowOwnEntries(chatId: string): SidebarSessionEntry[] {
    const entries = this.accountProjects.membersOf(chatId).flatMap((id) => {
      const project = this.projectManager.projects.get(id);
      return project ? this.projectSessionEntries(project) : [];
    });
    return entries.sort((a, b) => b.time - a.time);
  }

  /** Conversation entries of a project's visible tasks, newest interaction first. */
  private projectSessionEntries(project: ProjectStore): SidebarSessionEntry[] {
    const machine = this.machines?.machineOf(project.id) ?? null;
    if (machine) return this.remoteEntries(project.id, machine);
    if (!project.mountedProject) return [];
    const sessions = Array.from(project.mountedProject.sessionManager.sessions.values()).filter(
      (t) =>
        !t.data.automationRunId && (t.state === 'unregistered' || !t.data.archivedAt)
    );
    const entries: SidebarSessionEntry[] = [];
    for (const page of sessions) {
      const sessionId = page.data.id;
      for (const session of pageSessions(page)) {
        if (isAssistantAgent(sessionAgentBindings.bindingFor(session.data.id)?.agentUserId, this.assistantAgentId)) continue;
        entries.push({
          id: session.data.id,
          projectId: project.id,
          sessionId,
          parentSessionId: session.data.parentSessionId,
          isPinned: session.data.isPinned === true,
          time: session.data.lastInteractedAt
            ? new Date(session.data.lastInteractedAt).getTime()
            : 0,
          group: sidebarStateGroup(mountedSessionPresentation(session)),
          presentation: mountedSessionPresentation(session),
          unseen: !session.seen,
          title: session.data.title,
          createdAt: session.data.createdAt,
        });
      }
    }
    entries.sort((a, b) => b.time - a.time);
    return entries;
  }

  setAssistantAgentId(id: string | null): void {
    this.assistantAgentId = id;
  }

  /** Remote task entries exclude the assistant's own identity; delegated children remain tasks. */
  private remoteEntries(projectId: string, machine: string): SidebarSessionEntry[] {
    const listed = this.machines?.sessionsOf?.(machine);
    if (!listed) return [];
    const entries: SidebarSessionEntry[] = [];
    for (const session of listed.sessions) {
      if (session.projectId !== projectId) continue;
      const entry = this.remoteEntry(machine, projectId, session.conversationId);
      if (entry) entries.push(entry);
    }
    entries.sort((a, b) => b.time - a.time);
    return entries;
  }

  // @@@entry-by-id — 一条远程会话的条目只由它自己的目录行、它那个 agent 的 presence 与那台机器的连接派生,
  // 按 id 各一个 computed:一次 presence 推送只重算那个 agent 的那几条,别的条目原样(同一个对象)交回列表。
  // 表里只放此刻有人在看的那几个:被观察时放进来,没人看了(会话从目录里没了、机器换了、侧栏不在了)就拿掉 ——
  // ❌ 只加不删:用得越久表越大。只被命令式读一次的那个从不进表,读完即弃。
  private readonly remoteEntryById = new Map<string, IComputedValue<SidebarSessionEntry | null>>();

  private remoteEntry(machine: string, projectId: string, conversationId: string): SidebarSessionEntry | null {
    const key = `${machine}\u0000${projectId}\u0000${conversationId}`;
    let derived = this.remoteEntryById.get(key);
    if (!derived) {
      derived = computed(() => {
        const listed = this.remoteSession(projectId, conversationId);
        if (!listed) return null;
        const { summary: session, live } = listed;
        const agentId = session.agent?.userId ?? sessionAgentBindings.bindingFor(session.conversationId)?.agentUserId;
        // Direct-link freshness only governs access; identified agents share presence with avatars.
        const presentation = sessionPresentation(session, live, agentId);
        return {
          id: session.conversationId,
          projectId,
          sessionId: session.conversationId,
          parentSessionId: session.parentConversationId ?? null,
          isPinned: session.isPinned === true,
          time: session.lastInteractedAt ? new Date(session.lastInteractedAt).getTime() : 0,
          group: sidebarStateGroup(presentation),
          presentation,
          unseen: session.unseen === true,
          hostOnline: this.machines?.connected?.(machine) ?? live,
          title: session.title,
        };
      });
      const own = derived;
      onBecomeObserved(own, () => this.remoteEntryById.set(key, own));
      onBecomeUnobserved(own, () => {
        if (this.remoteEntryById.get(key) === own) this.remoteEntryById.delete(key);
      });
    }
    return derived.get();
  }

  /** #7199 这条会话是不是个人助理派出来的(父会话 / 由谁派的,一路往上有它自己的那条)。 */
  launchedByAssistant(projectId: string, sessionId: string): boolean {
    const assistantId = this.assistantAgentId;
    const machine = this.machines?.machineOf(projectId) ?? null;
    if (!assistantId || !machine) return false;
    const sessions = this.machines?.sessionsOf?.(machine)?.sessions ?? [];
    const byId = new Map(sessions.map((session) => [session.conversationId, session]));
    return launchedByAssistant(
      sessionId,
      (id) => {
        const session = byId.get(id);
        return session?.parentConversationId ?? session?.spawnedByConversationId ?? null;
      },
      (id) => {
        const session = byId.get(id);
        return !!session && isAssistantSession(session, assistantId);
      }
    );
  }

  /** 别的机器上的这条会话在目录里的那一行(行组件在会话还没挂载时画它);本机会话 / 目录里没有 = null。 */
  remoteSession(projectId: string, sessionId: string): RemoteSidebarSession | null {
    const machine = this.machines?.machineOf(projectId) ?? null;
    if (!machine) return null;
    const summary = this.machines?.session?.(machine, sessionId) ?? null;
    if (!summary || summary.projectId !== projectId) return null;
    const agentId = summary.agent?.userId ?? sessionAgentBindings.bindingFor(sessionId)?.agentUserId;
    return isAssistantAgent(agentId, this.assistantAgentId) ? null : { summary, live: this.machines?.sessionsOf?.(machine).live ?? false };
  }

  toggleIdleExpanded(foldKey: string): void {
    if (this.idleExpandedProjectIds.has(foldKey)) {
      this.idleExpandedProjectIds.delete(foldKey);
    } else {
      this.idleExpandedProjectIds.add(foldKey);
    }
  }

  toggleSessionExpanded(sessionId: string): void {
    if (this.expandedSessionIds.has(sessionId)) {
      this.expandedSessionIds.delete(sessionId);
    } else {
      this.expandedSessionIds.add(sessionId);
    }
  }

  /** 独立会话及助理家里的执行者。隐藏家目录项目行时,不能连同其中的任务一起摘掉。 */
  private standaloneOwnEntries(): SidebarSessionEntry[] {
    return [...this.projectManager.projects.values()]
      .filter((project) => this.isTasksProject(project))
      .flatMap((project) => this.projectSessionEntries(project))
      .sort((a, b) => b.time - a.time);
  }

  /**
   * 会话列在「任务」里的本地项目:不属于账号上任何项目的 —— #609 每台机器上的 workspace,以及对着手上那份账号项目
   * (读到的、上次留下的)仍对不上的(刚建、还没发布)。读失败也照这样列:❌ 让它的会话哪里都不列。只有头一次读、手上还
   * 一份都没有时只列 workspace(那时谁都对不上,不能把项目的会话全倒进「任务」再搬走)。
   * 「任务」是一张平铺的表,❌ 按机器分组。
   */
  private isTasksProject(project: { id: string; data?: { kind?: string } | null }): boolean {
    if (this.accountProjects.projectOfLocal(project.id)) return false;
    const { status, list } = this.accountProjects;
    return isWorkspaceProject(project) || status !== 'loading' || list.length > 0;
  }

  setAgentNameOnHoverEnabled(enabled: boolean): void {
    this.agentNameOnHoverEnabled = enabled;
  }

  get isEmpty(): boolean {
    return this.sidebarProjects.length === 0;
  }

  get snapshot(): SidebarSnapshot {
    return {
      expandedProjectIds: [...this.expandedProjectIds],
      expandedSessionIds: [...this.expandedSessionIds],
      idleExpandedProjectIds: [...this.idleExpandedProjectIds],
      projectOrder: [...this.projectOrder],
      sessionOrderByProject: { ...this.sessionOrderByProject },
      sessionSortBy: this.sessionSortBy,
    };
  }

  restoreSnapshot(snapshot: Partial<SidebarSnapshot>): void {
    if (snapshot.expandedProjectIds !== undefined) {
      this.expandedProjectIds.replace(snapshot.expandedProjectIds);
    }
    if (snapshot.expandedSessionIds !== undefined) {
      this.expandedSessionIds.replace(snapshot.expandedSessionIds);
    }
    if (snapshot.idleExpandedProjectIds !== undefined) {
      this.idleExpandedProjectIds.replace(snapshot.idleExpandedProjectIds);
    }
    if (snapshot.projectOrder !== undefined) {
      this.projectOrder = [...snapshot.projectOrder];
    }
    if (snapshot.sessionOrderByProject !== undefined) {
      this.sessionOrderByProject = { ...snapshot.sessionOrderByProject };
    }
    if (snapshot.sessionSortBy !== undefined) {
      const v = parseSidebarSessionSortBy(snapshot.sessionSortBy);
      if (v !== undefined) this.sessionSortBy = v;
    }
    // Blobs written by the old desktop sidebar still carry its section folds and 项目 | 对话 layout (pinnedCollapsed,
    // projectsCollapsed, sessionsCollapsed, chatsCollapsed, listLayout, listPage): nothing reads them any more.
  }

  ensureProjectExpanded(projectId: string): void {
    this.expandedProjectIds.add(this.rowProjectIdOf(projectId));
  }

  /** behavior session-page「键盘导航」: ← on a project row collapses it, so the keyboard skips it whole. */
  collapseProject(projectId: string): void {
    this.expandedProjectIds.delete(projectId);
  }

  /** 新建的在前;没有本地项目的项目(不知道哪天建的)排在后面。 */
  private compareSidebarProjects(a: SidebarProjectRef, b: SidebarProjectRef): number {
    const createdAt = (ref: SidebarProjectRef) => (ref.kind === 'local' ? ref.project.createdAt ?? '' : '');
    const d = createdAt(b).localeCompare(createdAt(a));
    if (d !== 0) return d;
    return a.id.localeCompare(b.id);
  }
}
