import { ChevronLeft, ChevronRight, SquarePen, Users } from '@/lib/icons';
import { computed, observable, runInAction } from 'mobx';
import { observer } from 'mobx-react-lite';
import { useCallback, useEffect, useLayoutEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Avatar } from '@/components/Avatar';
import { ListColumnToggle } from '@/components/PanelToggleButtons';
import { ChatDetailsMenuItems } from '@/components/chat/ChatDetailsMenuItems';
import { IconButton } from '@/components/ui/IconButton';
import { MenuItem, MenuSeparator } from '@/components/ui/Menu';
import { useShownAgentName } from '@/hooks/useShownAgentName';
import { useChatSummaries, type ChatSummary } from '@/lib/chatSummariesBridge';
import { setComposerVerb } from '@/lib/composerVerbBridge';
import { readIdentityDirectoryBridge } from '@/lib/identityDirectoryBridge';
import {
  innerSidebarTopicsSlotKey,
  publishInnerSidebarChat,
  publishMyChatAgentCounts,
  setInnerSidebarTopicsAll,
  useInnerSidebarTopicsAll,
  useInnerSidebarTopicsView,
  useOneListAgentRows,
  type ChatAgentCounts,
  type InnerSidebarTopicsView,
  type OneListAgentRow,
  type OneListAgentRows,
} from '@/lib/innerSidebarBridge';
import { publishPanelToggle } from '@/lib/panelToggles';
import { readShellSlots } from '@/lib/shellSlots';
import { ProjectFolderAvatar } from '@/mobile/partners/ProjectFolderAvatar';
import { openInfoTab } from '@renderer/features/chats/chat-tabs/chat-layouts';
import { openChatOnScreen } from '@renderer/features/chats/open-chat';
import { ProjectMenuItems } from '@renderer/features/projects/components/project-menu';
import { prepareProjectTask } from '@renderer/features/projects/project-task-entry';
import { accountProjectsStore } from '@renderer/features/projects/stores/account-projects-store';
import { openSessionInSessionWhenReady } from '@renderer/features/sessions/open-session-in-session';
import { sessionAgentBindings } from '@renderer/features/sessions/stores/session-agent-bindings';
import { sampleProjectInView } from '@renderer/features/sample-project/sample-project-view';
import { useSampleProject } from '@renderer/features/sample-project/use-sample-project';
import { SIDEBAR_DEFAULT_WIDTH_PX } from '@renderer/lib/layout/layout-provider';
import { ShellRestoreLane } from '@renderer/lib/components/titlebar/shell-restore-lane';
import { appState, sidebarStore } from '@renderer/lib/stores/app-state';
import { Button } from '@renderer/lib/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/lib/ui/tooltip';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import {
  agentFamilies,
  chatAgentCounts,
  chatAgentNeedsYou,
  chatAgentSection,
  myAgentsInChat,
  subAgentsOf,
  type AgentFamilies,
  type ChatAgentEntry,
  type ChatAgentScope,
} from './chat-agents';
import {
  followInnerSidebar,
  innerSidebarChat,
  type InnerSidebarAgentAnchor,
  type InnerSidebarAnchor,
  type InnerSidebarRoomAnchor,
  type InnerSidebarView,
} from './inner-sidebar-anchor';
import { innerSidebarFolded, innerSidebarFoldedAway, setInnerSidebarFolded } from './inner-sidebar-fold';
import {
  InnerHeadActionsMenu,
  InnerHeadRowLayout,
  InnerSidebarFoldButton,
  innerSectionEmptyClass,
  innerSectionHeaderClass,
} from './inner-sidebar-parts';
import { SidebarGroupToggle } from './sidebar-group-toggle';
import { SidebarUnreadCount } from './sidebar-unread-count';
import { SidebarMoreRow } from './sidebar-more-row';
import {
  SidebarContainer,
  SidebarContent,
  SidebarGroup,
  SidebarMenu,
  sidebarCountClass,
} from './sidebar-primitives';
import { SampleInnerSidebar } from './sample-inner-sidebar';
import { SidebarSessionItem } from './sidebar-session-item';

// #2548 内层侧栏:桌面上打开一个用户群或一个项目时,左边列表与对话之间多出来的一列(手机永不出现)。分区顺序:群里「话题」在上、「我的智能体」在下;项目里「智能体」在上、「话题」在下。
// #2574 有子智能体的独立智能体也有这一列:头一行是它自己,下面只有「智能体」(它的子智能体);没有子智能体就照旧没有这一列。
// 手机永不出现是结构上的:这一列住在会话页的工作区里,手机壳不画工作区(check-ui-visual-spec 守着「任务渲染层只在桌面」)。
// 这一列只重排现有的组件:头一行是侧栏顶上那几行动作行(SidebarMenuButton)画这个群 / 项目自己,分区头是侧栏分区头,
// 智能体行是任务区那一行(SidebarSessionItem,行首换成 agent 自己的头像:agentAvatar),话题行由壳画进「话题」那一格(components/ChatListSlotHost.tsx →
// InnerSidebarTopics,同一个动作行的样子)。这一列里 ❌ 找的框:找东西用列表顶上那个搜索(开着群时先搜这个群,sidebar-search-trigger)。
// 这一列可以收起(inner-sidebar-fold):收起是全局的,正文左上角浮出展开钮(InnerSidebarRestore)。

/** 侧栏里我的每一条会话,带上它背后的 agent(同 SidebarSessionItem 认身份的两条腿)。 */
export function mySidebarAgents(): ChatAgentEntry[] {
  return [...sidebarStore.placement.nodeById.values()].map(({ item }) => ({
    id: item.id,
    projectId: item.projectId,
    parentSessionId: item.parentSessionId,
    isPinned: item.isPinned,
    time: item.time,
    presentation: item.presentation,
    unseen: item.unseen,
    hostOnline: item.hostOnline,
    agentUserId:
      sessionAgentBindings.bindingFor(item.id)?.agentUserId ??
      sidebarStore.remoteSession(item.projectId, item.id)?.summary.agent?.userId,
  }));
}

/** 这个项目(账号上的项目 = 它的项目群)在各台机器上的本地项目,代表在最前;一个文件夹都没有 = []。 */
function projectIdsOfChat(chatId: string): readonly string[] {
  return accountProjectsStore.membersOf(chatId);
}

/** 这个群是不是侧栏列着的一个项目(账号上的项目,归档的不列):是 = 内层侧栏按项目画它。 */
export function isProjectChat(chatId: string): boolean {
  return sidebarStore.sidebarProjects.some((ref) => ref.chatId === chatId);
}

export function chatScope(anchor: InnerSidebarRoomAnchor, summaries: ReadonlyMap<string, ChatSummary>): ChatAgentScope {
  const memberUserIds = summaries.get(anchor.chatId)?.memberUserIds ?? [];
  return anchor.kind === 'group'
    ? { kind: 'group', memberUserIds }
    : { kind: 'project', projectIds: projectIdsOfChat(anchor.chatId), memberUserIds };
}

/** 侧栏里我的会话与它们的父子,数据变了才重编一遍(这一列每次渲染都要读;在跑的 agent 每跳一下状态它就重画一次)。 */
const sidebarFamilies = computed(() => agentFamilies(mySidebarAgents()));

/**
 * 这一列「智能体」里的那些:群 / 项目里我的智能体,或一个独立智能体的子智能体(#2574;一个列表不再把它画成自己一行,
 * 这一列也就不在了)。
 */
function columnAgents(
  anchor: InnerSidebarAnchor,
  families: AgentFamilies,
  summaries: ReadonlyMap<string, ChatSummary>,
  agentRows: OneListAgentRows | null
): ChatAgentEntry[] {
  if (anchor.kind !== 'agent') return myAgentsInChat(families.entries, chatScope(anchor, summaries));
  return agentRows?.get(anchor.agentUserId)?.chatId === anchor.chatId ? subAgentsOf(families, anchor.agentUserId) : [];
}

/**
 * #2574 这条会话开出来的那个独立智能体的一列:这条会话是它自己的一条顶层会话(❌ 它挂在别人树下的分身)、一个列表把它画成了
 * 自己一行(OneListAgentRows:「有自己一行」只有列表那一份判法,❌ 这里再推一遍)、它至少有一个子智能体;否则 null(照今天的样子开)。
 */
function standaloneAgentAnchor(sessionId: string, families: AgentFamilies, agentRows: OneListAgentRows | null): InnerSidebarAgentAnchor | null {
  const entry = families.byId.get(sessionId);
  const agentUserId = entry && !entry.parentSessionId ? entry.agentUserId : undefined;
  const row = agentUserId ? agentRows?.get(agentUserId) : undefined;
  if (!agentUserId || !row || subAgentsOf(families, agentUserId).length === 0) return null;
  return { kind: 'agent', chatId: row.chatId, agentUserId };
}

/** 导航此刻在哪(读成内层侧栏要的样子)。 */
function currentView(summaries: ReadonlyMap<string, ChatSummary>): InnerSidebarView {
  const { currentViewId, viewParamsStore } = appState.navigation;
  if (currentViewId === 'chat') {
    const chatId = (viewParamsStore.chat as { chatId?: string } | undefined)?.chatId;
    if (!chatId) return { kind: 'other' };
    return {
      kind: 'chat',
      chatId,
      chatKind: summaries.get(chatId)?.kind ?? null,
      projectGroup: isProjectChat(chatId),
    };
  }
  if (currentViewId === 'project') {
    const projectId = (viewParamsStore.project as { projectId?: string } | undefined)?.projectId;
    return projectId ? { kind: 'project', chatId: accountProjectsStore.projectOfLocal(projectId)?.chatId } : { kind: 'other' };
  }
  if (currentViewId === 'session') {
    const sessionId = (viewParamsStore.session as { sessionId?: string } | undefined)?.sessionId;
    return sessionId ? { kind: 'session', sessionId } : { kind: 'other' };
  }
  return { kind: 'other' };
}

// 它住在 inner-sidebar-anchor(轻,列表顶上的搜索也读它);从这里照旧拿得到。
export { innerSidebarChat };

/**
 * What the inner sidebar is drawn for: a chat's id, `'sample'` for the sample project, null while it is not drawn (none, or
 * folded away). The foot's one-time intro (C9) comes up the first time it appears: the page gets crowded either way, the
 * sample included.
 */
export const innerSidebarShownFor = observable.box<string | null>(null);

/** 挂在工作区里,列表与对话之间(WorkspaceLayout 的 innerSidebar)。不该出现时什么都不画。 */
export const InnerSidebar = observer(function InnerSidebar() {
  const { translate } = useSessionMessages();
  const summaries = useChatSummaries();
  const agentRows = useOneListAgentRows();
  const families = sidebarFamilies.get();
  const agents = families.entries;
  const [anchor, setAnchor] = useState<InnerSidebarAnchor | null>(null);
  const view = currentView(summaries);
  const next = followInnerSidebar(
    anchor,
    view,
    (previous, sessionId) => columnAgents(previous, families, summaries, agentRows).some((entry) => entry.id === sessionId),
    (sessionId) => standaloneAgentAnchor(sessionId, families, agentRows)
  );
  // 上一次挂在哪是这一列自己记的(从这一列点开一个智能体,它还留着):换了才记,同一个对话不重设。
  if (next?.chatId !== anchor?.chatId || next?.kind !== anchor?.kind) setAnchor(next);
  // 换了对话就回到第一级(「全部」只对那一个对话)。
  useEffect(() => setInnerSidebarTopicsAll(null), [next?.chatId]);
  useEffect(() => runInAction(() => innerSidebarChat.set(next)), [next?.chatId, next?.kind]);
  // 壳据此收起对话页头上与这一列重复的按钮(成员、话题、邀请)。
  useEffect(() => publishInnerSidebarChat(next?.chatId ?? null), [next?.chatId]);
  // 头一行是这一列自己:群 / 项目开着它的对话时,智能体开着它自己的(顶层)会话时(❌ 它的子智能体)。
  const ownSessions = next?.kind === 'agent' ? (families.topLevelOf.get(next.agentUserId) ?? []) : [];
  const headActive =
    next?.kind === 'agent'
      ? view.kind === 'session' && ownSessions.some((entry) => entry.id === view.sessionId)
      : (view.kind === 'chat' || view.kind === 'project') && view.chatId === next?.chatId;
  // 示例项目(#709)那一块正看着:这一列画示例自己(打包在 app 里的内容,❌ 群、❌ 网络)。它不是哪一个对话,所以 ❌ 进 innerSidebarChat;
  // 账号上的键说它不在了(刚移除),这一列跟那一行同时收。
  const sample = useSampleProject();
  const sampleOwnerId = next === null && sample.shown && sampleProjectInView() ? sample.owner?.id : undefined;
  const attachedTo = next?.chatId ?? (sampleOwnerId ? 'sample' : null);
  // 收起着:这一列 ❌ 画,挂在哪照旧跟着(左边那一行照旧亮着、壳照旧收起页头上与它重复的钮),正文左上角浮出展开钮。
  const folded = innerSidebarFolded.get();
  const shownFor = folded ? null : attachedTo;
  const foldedAway = folded && attachedTo !== null;
  useEffect(() => {
    runInAction(() => innerSidebarShownFor.set(shownFor));
    return () => runInAction(() => innerSidebarShownFor.set(null));
  }, [shownFor]);
  // 展开钮是列表栏开关那一颗(ListColumnToggle),经同一张开关表下命令(@@@panel-toggles)。
  // 两件都赶在这一帧画出来之前、按这个次序:这一列让开的同一帧,展开钮(已是「展开」那一态)与页签条让出的车道就在,❌ 中间空一帧。
  const foldLabel = translate(folded ? 'sidebar.expandInner' : 'sidebar.collapseInner');
  useLayoutEffect(
    () => publishPanelToggle('column:inner', { open: !folded, label: foldLabel, toggle: () => setInnerSidebarFolded(!folded) }),
    [folded, foldLabel]
  );
  useLayoutEffect(() => {
    runInAction(() => innerSidebarFoldedAway.set(foldedAway));
    return () => runInAction(() => innerSidebarFoldedAway.set(false));
  }, [foldedAway]);

  return (
    <>
      <MyChatAgentCountsPublisher agents={agents} summaries={summaries} />
      {folded ? null : next?.kind === 'agent' ? (
        <InnerAgentColumn
          key={next.chatId}
          anchor={next}
          row={agentRows?.get(next.agentUserId) ?? null}
          ownSession={ownSessions[0] ?? null}
          headActive={headActive}
          agents={columnAgents(next, families, summaries, agentRows)}
        />
      ) : next ? (
        // 换一个对话 = 新的一列(分区收起都是这一个对话的);同一个对话里切「全部 / 返回」不重建,滚动位置留着。
        <InnerSidebarColumn
          key={next.chatId}
          anchor={next}
          summary={summaries.get(next.chatId) ?? null}
          headActive={headActive}
          agents={columnAgents(next, families, summaries, agentRows)}
        />
      ) : sampleOwnerId ? (
        <InnerSidebarFrame kind="sample">
          <SampleInnerSidebar ownerId={sampleOwnerId} />
        </InnerSidebarFrame>
      ) : null}
    </>
  );
});

/**
 * 内层栏收起时正文左上角那枚展开钮(#2548 ⑤):列表栏开关那一颗,浮在左边列表那枚「展开侧栏」的车道上,最左那条页签条给它让位
 * (shellRestoreLaneTaken)。❌ 挂数:话题里叫到你的记在左边群那一行的红数上。
 */
export const InnerSidebarRestore = observer(function InnerSidebarRestore() {
  if (!innerSidebarFoldedAway.get()) return null;
  return (
    <ShellRestoreLane>
      <ListColumnToggle slot="column:inner" />
    </ShellRestoreLane>
  );
});

/** 项目行头像角上那个数(#2548):每个项目群里我的智能体,与分区头同一个推导。 */
const MyChatAgentCountsPublisher = observer(function MyChatAgentCountsPublisher({
  agents,
  summaries,
}: {
  agents: readonly ChatAgentEntry[];
  summaries: ReadonlyMap<string, ChatSummary>;
}) {
  const counts = new Map<string, ChatAgentCounts>();
  for (const ref of sidebarStore.sidebarProjects) {
    const chatId = ref.chatId;
    if (counts.has(chatId)) continue;
    counts.set(chatId, chatAgentCounts(myAgentsInChat(agents, chatScope({ kind: 'project', chatId }, summaries))));
  }
  // 依赖是序列化后的数:每次渲染新建的 Map 不算变化(publish 自己也只在数变了时才通知)。
  const key = JSON.stringify([...counts]);
  useEffect(() => publishMyChatAgentCounts(counts), [key]);
  return null;
});

const InnerSidebarColumn = observer(function InnerSidebarColumn({
  anchor,
  summary,
  headActive,
  agents,
}: {
  anchor: InnerSidebarRoomAnchor;
  summary: ChatSummary | null;
  headActive: boolean;
  agents: readonly ChatAgentEntry[];
}) {
  const levelTwo = useInnerSidebarTopicsAll() === anchor.chatId;
  const topicsView = useInnerSidebarTopicsView(anchor.chatId);
  const topics = <InnerTopicsSection chatId={anchor.chatId} levelTwo={levelTwo} view={topicsView} />;
  const agentsSection = <InnerAgentsSection anchor={anchor} agents={agents} />;
  return (
    <InnerSidebarFrame kind={anchor.kind} chatId={anchor.chatId}>
      <InnerHeadRow anchor={anchor} summary={summary} active={headActive} running={chatAgentCounts(agents).running} />
      <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto" data-region="inner-sidebar-scroll">
        {/* 第二级(全部话题):「话题」上面的分区原样留着,下面的收走 —— 「全部 › / ‹ 返回」因此永远在同一个位置。 */}
        {anchor.kind === 'project' ? (
          <>
            {agentsSection}
            {topics}
          </>
        ) : (
          <>
            {topics}
            {levelTwo ? null : agentsSection}
          </>
        )}
      </div>
    </InnerSidebarFrame>
  );
});

/**
 * #2574 一个独立智能体的那一列:头一行是它自己,下面只有「智能体」 —— 它的子智能体,规矩同群 / 项目那一个分区
 * (同一个 InnerAgentsSection)。❌「话题」:它的对话是它的会话,话题长在聊天里,不在这里。
 */
const InnerAgentColumn = observer(function InnerAgentColumn({
  anchor,
  row,
  ownSession,
  headActive,
  agents,
}: {
  anchor: InnerSidebarAgentAnchor;
  /** 一个列表里它那一行(这一列只开在那一行上,所以一定有)。 */
  row: OneListAgentRow | null;
  /** 它自己最近的那条顶层会话:头一行点回去的地方。 */
  ownSession: ChatAgentEntry | null;
  headActive: boolean;
  agents: readonly ChatAgentEntry[];
}) {
  if (!row || !ownSession) throw new Error(`The agent column of ${anchor.agentUserId} is open without its list row or its own session`);
  return (
    <InnerSidebarFrame kind="agent" chatId={anchor.chatId}>
      <InnerAgentHeadRow anchor={anchor} row={row} ownSession={ownSession} active={headActive} />
      <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto" data-region="inner-sidebar-scroll">
        <InnerAgentsSection anchor={anchor} agents={agents} />
      </div>
    </InnerSidebarFrame>
  );
});

/** 这一列本身(群 / 项目 / 智能体 / 示例都是它):列表与正文之间、默认侧栏宽的一列;里面是头一行(这一列顶上那条带)与分区。 */
function InnerSidebarFrame({ kind, chatId, children }: { kind: InnerSidebarAnchor['kind'] | 'sample'; chatId?: string; children: ReactNode }) {
  return (
    // isolate:分区头、行里那几层 z 序关在这一列里,❌ 压过左边列表那根拖动分隔条。
    // 底色是正文的底色:这一列是叠在列表上那张卡片的左半(desktop-shell.css「叠一层」,#2548),❌ 侧栏那一档。
    <div
      data-region="inner-sidebar"
      data-inner-sidebar-chat={chatId}
      data-inner-sidebar-kind={kind}
      className="relative isolate flex h-full shrink-0 flex-col border-r border-border bg-background text-foreground-tertiary-muted"
      style={{ width: SIDEBAR_DEFAULT_WIDTH_PX }}
    >
      <SidebarContainer className="min-h-0 w-full flex-1">
        <SidebarContent className="flex flex-col">{children}</SidebarContent>
      </SidebarContainer>
    </div>
  );
}

const noIdentities = () => () => undefined;

/** 群的脸:群自己设的头像,没设就是成员拼图(同聊天列表那一行),身份从壳的身份目录读。 */
function GroupHeadAvatar({ chatId, summary }: { chatId: string; summary: ChatSummary | null }) {
  const directory = readIdentityDirectoryBridge();
  const identities = useSyncExternalStore(directory?.subscribe ?? noIdentities, () => directory?.getSnapshot() ?? null, () => null);
  const memberIds = summary?.memberUserIds ?? [];
  const missing = memberIds.filter((id) => !identities?.[id]).join(',');
  useEffect(() => {
    if (missing) directory?.ensure(missing.split(','));
  }, [directory, missing]);
  return (
    <Avatar
      name={summary?.name ?? ''}
      avatarUrl={summary?.avatar}
      seed={chatId}
      size={24}
      variant="group"
      harnessBadge={false}
      memberAvatars={memberIds.flatMap((id) => {
        const identity = identities?.[id];
        return identity ? [{ id, name: identity.display_name, avatar: identity.avatar }] : [];
      })}
    />
  );
}

/**
 * 头一行就是这个群 / 项目自己:头像 + 名字,点它回到群聊(群聊开着时它是选中的)。行尾:「…」(悬停才出:群信息与设置、成员,
 * 项目再加项目那份菜单)、新智能体(常显)、收起这一列(常显,最右)。几枚钮是「对话」分区头上那种钮。
 * ❌ 未读数(#2548 提议稿 state0):这个群的数挂在左边列表它那一行上(叫到你的才是红数,其余一颗灰点),这里再挂一份就是两处。
 */
const InnerHeadRow = observer(function InnerHeadRow({
  anchor,
  summary,
  active,
  running,
}: {
  anchor: InnerSidebarRoomAnchor;
  summary: ChatSummary | null;
  active: boolean;
  running: number;
}) {
  const { translate } = useSessionMessages();
  const { t } = useTranslation('messaging');
  const { chatId } = anchor;
  const name = summary?.name ?? '';
  // 项目的代表本地项目(与侧栏那一行同一个);一个文件夹都没有的项目没有 —— 新智能体走群那一条,封面按群取色(同 partnerProjects)。
  const rowProjectId = anchor.kind === 'project' ? accountProjectsStore.representativeOf(chatId) : undefined;
  const actionsLabel = translate(anchor.kind === 'project' ? 'sidebar.projectActions' : 'sidebar.groupActions');
  const newAgentLabel = translate(anchor.kind === 'project' ? 'sidebar.newAgentInProject' : 'sidebar.newAgentInGroup');
  const openInfo = (page?: 'members') => {
    openChatOnScreen(chatId, false);
    openInfoTab(chatId, page);
  };
  // 同输入框「+」右边那个「新任务」:项目走项目行「+」那一条(prepareProjectTask),群把这个群的框换成新任务。
  const newAgent = () => {
    if (rowProjectId) prepareProjectTask(rowProjectId);
    else setComposerVerb(chatId, 'task', '', { name, joinable: true });
    openChatOnScreen(chatId, false);
  };
  const avatar: ReactNode = anchor.kind === 'project' ? (
    <ProjectFolderAvatar coverId={rowProjectId ?? chatId} running={running} size={24} />
  ) : (
    <GroupHeadAvatar chatId={chatId} summary={summary} />
  );
  return (
    <InnerHeadRowLayout headKey={chatId} name={name} avatar={avatar} active={active} onOpen={() => openChatOnScreen(chatId, false)} trailingButtons={2}>
      <InnerHeadActionsMenu label={actionsLabel}>
        <ChatDetailsMenuItems isGroupChat onOpenInfo={() => openInfo()} />
        <MenuItem icon={<Users size={16} />} onClick={() => openInfo('members')}>
          {t('header.memberList')}
        </MenuItem>
        {rowProjectId ? (
          <>
            <MenuSeparator />
            <ProjectMenuItems projectId={rowProjectId} chatId={chatId} />
          </>
        ) : null}
      </InnerHeadActionsMenu>
      <Tooltip>
        <TooltipTrigger
          render={
            <IconButton size="md" tone="strong" aria-label={newAgentLabel} data-inner-head-new-agent="" onClick={newAgent}>
              <SquarePen />
            </IconButton>
          }
        />
        <TooltipContent>{newAgentLabel}</TooltipContent>
      </Tooltip>
      <InnerSidebarFoldButton />
    </InnerHeadRowLayout>
  );
});

/**
 * #2574 独立智能体那一列的头一行:它自己 —— 左边列表它那一行的名字与头像(同一份,同一层「起名中」),点它直接回到它自己的会话
 * (❌ 绕道打开私聊:那一下若落成聊天视图,这一列就跟着收了)。
 * 行尾只有收起这一列(最右,同群 / 项目):
 *  · ❌ 新智能体那支笔:子智能体是它自己派出去的,这里没有「在它里面新建」这件事;新建一个智能体是列表顶上那一行。
 *  · ❌「…」:群 / 项目的「…」装的是页头让给这一列的群信息、成员;智能体的页头什么都没让出来,它自己的菜单在左边它那一行上。
 */
const InnerAgentHeadRow = observer(function InnerAgentHeadRow({
  anchor,
  row,
  ownSession,
  active,
}: {
  anchor: InnerSidebarAgentAnchor;
  row: OneListAgentRow;
  ownSession: ChatAgentEntry;
  active: boolean;
}) {
  const name = useShownAgentName({ name: row.name, createdAt: row.createdAt ?? undefined });
  const openOwnSession = () => {
    const target = { projectId: ownSession.projectId, sessionId: ownSession.id };
    appState.navigation.navigate('session', target);
    openSessionInSessionWhenReady(target);
  };
  return (
    <InnerHeadRowLayout
      headKey={anchor.chatId}
      name={name}
      avatar={<Avatar name={name} avatarUrl={row.avatar} seed={anchor.agentUserId} size={24} isAgent harnessBadge={false} still />}
      active={active}
      onOpen={openOwnSession}
      trailingButtons={1}
      hoverMenu={false}
    >
      <InnerSidebarFoldButton />
    </InnerHeadRowLayout>
  );
});

function InnerTopicsSection({ chatId, levelTwo, view }: { chatId: string; levelTwo: boolean; view: InnerSidebarTopicsView | null }) {
  const { translate } = useSessionMessages();
  const [collapsed, setCollapsed] = useState(false);
  const slot = useCallback(
    (element: HTMLDivElement | null) => readShellSlots()?.setSlot(innerSidebarTopicsSlotKey(chatId), element),
    [chatId]
  );
  const canDrill = levelTwo || (view?.hidden ?? 0) > 0;
  return (
    <SidebarGroup className="mb-2 flex shrink-0 flex-col" data-inner-sidebar-section="topics">
      <div className={innerSectionHeaderClass}>
        <span className="flex items-center gap-1">
          <SidebarGroupToggle
            label={translate('sidebar.topics')}
            count={0}
            collapsed={collapsed}
            onToggle={() => setCollapsed((value) => !value)}
            ariaLabel={translate(collapsed ? 'sidebar.expandTopics' : 'sidebar.collapseTopics')}
          />
          {view && view.total > 0 ? <span className={sidebarCountClass}>{view.total}</span> : null}
          {/* 收起时标题旁挂里面叫到你的(同「对话」分区头那个未读数)。 */}
          {collapsed ? <SidebarUnreadCount count={view?.calling ?? 0} /> : null}
        </span>
        {/* 全部话题只有这一个入口(#2548 ⑦「一个去处一个入口」):❌ 行底下再一行「全部 N 个话题」。 */}
        {!collapsed && canDrill ? (
          <Button
            variant="ghost"
            size="xs"
            data-inner-topics-drill={levelTwo ? 'back' : 'all'}
            onClick={() => setInnerSidebarTopicsAll(levelTwo ? null : chatId)}
          >
            {levelTwo ? (
              <>
                <ChevronLeft data-icon="inline-start" />
                {translate('common.back')}
              </>
            ) : (
              <>
                {translate('sidebar.allTopics')}
                <ChevronRight data-icon="inline-end" />
              </>
            )}
          </Button>
        ) : null}
      </div>
      {/* 话题行画进这一格(壳那棵树);格子里的东西归壳管,这一侧 ❌ 往里放子元素。左右留白归 list body(SidebarMenu)。 */}
      {collapsed ? null : (
        <SidebarMenu>
          <div ref={slot} data-region="inner-sidebar-topics" className="min-h-0" />
        </SidebarMenu>
      )}
      {!collapsed && view?.total === 0 ? (
        <div className={innerSectionEmptyClass}>{translate('sidebar.noTopics')}</div>
      ) : null}
    </SidebarGroup>
  );
}

/**
 * 「智能体」:标题旁一个数(总数,连子会话),❌ 药丸、❌「需要你 / 运行中」组头(#2548 ⑥):一张平的表(chatAgentSection),
 * 是哪一档只看行尾那几个记号。群里也只列我的,标题照样写「智能体」(owner 11-12)。
 */
const InnerAgentsSection = observer(function InnerAgentsSection({ anchor, agents }: { anchor: InnerSidebarAnchor; agents: readonly ChatAgentEntry[] }) {
  const { translate } = useSessionMessages();
  const [collapsed, setCollapsed] = useState(false);
  // 「展开显示」点开了没有,记在侧栏同一张表里,键与项目 / 任务分区分开。
  const foldKey = `chat:${anchor.chatId}`;
  const showAll = sidebarStore.idleExpandedProjectIds.has(foldKey);
  const list = chatAgentSection(agents, { expanded: sidebarStore.expandedSessionIds, showAll });
  const total = chatAgentCounts(agents).total;
  return (
    <SidebarGroup className="mb-2 flex shrink-0 flex-col" data-inner-sidebar-section="agents">
      <div className={innerSectionHeaderClass}>
        <span className="flex items-center gap-1">
          <SidebarGroupToggle
            label={translate('sidebar.agents')}
            count={0}
            collapsed={collapsed}
            onToggle={() => setCollapsed((value) => !value)}
            ariaLabel={translate(collapsed ? 'sidebar.expandAgents' : 'sidebar.collapseAgents')}
          />
          {total > 0 ? <span className={sidebarCountClass} data-inner-agents-count="">{total}</span> : null}
          {collapsed ? <SidebarUnreadCount count={chatAgentNeedsYou(agents)} /> : null}
        </span>
      </div>
      {collapsed ? null : total === 0 ? (
        <div className={innerSectionEmptyClass}>{translate('sidebar.noAgents')}</div>
      ) : (
        <SidebarMenu className="pb-1">
          {list.rows.map((row) => (
            <SidebarSessionItem
              key={row.sessionId}
              projectId={row.projectId}
              sessionId={row.sessionId}
              rowVariant="section"
              depth={row.depth}
              parentProjectId={row.parentProjectId}
              hasChildren={row.hasChildren}
              expanded={sidebarStore.expandedSessionIds.has(row.sessionId)}
              needsAttention={row.needsAttention}
              treeSummary={row.summary}
              onToggle={() => sidebarStore.toggleSessionExpanded(row.sessionId)}
              sidebarPinMark
              agentAvatar
            />
          ))}
          {list.overflow > 0 ? <SidebarMoreRow foldKey={foldKey} expanded={showAll} hiddenCount={list.overflow} /> : null}
        </SidebarMenu>
      )}
    </SidebarGroup>
  );
});
