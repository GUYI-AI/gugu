import { ChevronLeft, ChevronRight, MoreHorizontal, SquarePen, Users } from '@/lib/icons';
import { observable, runInAction } from 'mobx';
import { observer } from 'mobx-react-lite';
import { useCallback, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Avatar } from '@/components/Avatar';
import { ChatDetailsMenuItems } from '@/components/chat/ChatDetailsMenuItems';
import { DropdownMenu, MenuItem, MenuSeparator } from '@/components/ui/Menu';
import { SearchField } from '@/components/ui/SearchField';
import { useChatSummaries, type ChatSummary } from '@/lib/chatSummariesBridge';
import { setComposerVerb } from '@/lib/composerVerbBridge';
import { readIdentityDirectoryBridge } from '@/lib/identityDirectoryBridge';
import {
  innerSidebarTopicsSlotKey,
  publishInnerSidebarChat,
  publishMyChatAgentCounts,
  setInnerSidebarFilter,
  setInnerSidebarTopicsAll,
  useInnerSidebarTopicsAll,
  useInnerSidebarTopicsView,
  type ChatAgentCounts,
  type InnerSidebarTopicsView,
} from '@/lib/innerSidebarBridge';
import { readShellSlots } from '@/lib/shellSlots';
import { useSidebarChatSignals } from '@/lib/sidebarChatsBridge';
import { ProjectFolderAvatar } from '@/mobile/partners/ProjectFolderAvatar';
import { openInfoTab } from '@renderer/features/chats/chat-tabs/chat-layouts';
import { openChatOnScreen } from '@renderer/features/chats/open-chat';
import { ProjectMenuItems } from '@renderer/features/projects/components/project-menu';
import { prepareProjectTask } from '@renderer/features/projects/project-task-entry';
import { projectGroupsStore } from '@renderer/features/projects/stores/project-groups-store';
import { sessionAgentBindings } from '@renderer/features/sessions/stores/session-agent-bindings';
import { SIDEBAR_DEFAULT_WIDTH_PX } from '@renderer/lib/layout/layout-provider';
import { appState, sidebarStore } from '@renderer/lib/stores/app-state';
import { Button } from '@renderer/lib/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/lib/ui/tooltip';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { cn } from '@renderer/utils/utils';
import {
  chatAgentCounts,
  chatAgentNeedsYou,
  chatAgentPill,
  chatAgentSection,
  chatAgentsMatch,
  myAgentsInChat,
  type ChatAgentEntry,
  type ChatAgentScope,
} from './chat-agents';
import { followInnerSidebar, innerSidebarHasFilter, type InnerSidebarAnchor, type InnerSidebarView } from './inner-sidebar-anchor';
import { SidebarGroupToggle } from './sidebar-group-toggle';
import { SidebarUnreadCount } from './sidebar-unread-count';
import { SidebarMoreRow } from './sidebar-more-row';
import {
  SidebarContainer,
  SidebarContent,
  SidebarGroup,
  SidebarMenu,
  SidebarMenuButton,
  sidebarCountClass,
  sidebarGroupHeaderClass,
  sidebarHeaderIconButtonClass,
  sidebarRowContentInsetX,
} from './sidebar-primitives';
import { SidebarSessionBranchCount } from './sidebar-session-branch-view';
import { SidebarSessionItem } from './sidebar-session-item';
import { SidebarSpace } from './sidebar-space';
import { SidebarStateHeader } from './sidebar-state-header';

// #2548 内层侧栏:桌面上打开一个用户群或一个项目时,左边列表与对话之间多出来的一列(手机永不出现)。分区顺序:群里「话题」在上、「我的智能体」在下;项目里「智能体」在上、「话题」在下。
// 手机永不出现是结构上的:这一列住在会话页的工作区里,手机壳不画工作区(check-ui-visual-spec 守着「任务渲染层只在桌面」)。
// 这一列只重排现有的组件:头一行是侧栏顶上那几行动作行(SidebarMenuButton)画这个群 / 项目自己,分区头是侧栏分区头,
// 智能体行是任务区那一行(SidebarSessionItem,行首换成 agent 自己的头像:agentAvatar),话题行由壳画进「话题」那一格(components/ChatListSlotHost.tsx →
// InnerSidebarTopics,同一个动作行的样子)。东西多时头行下面一个「找」的框,话题与智能体一起筛。

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
    title: item.title,
    agentUserId:
      sessionAgentBindings.bindingFor(item.id)?.agentUserId ??
      sidebarStore.remoteSession(item.projectId, item.id)?.summary.agent?.userId,
  }));
}

/** 这个项目群绑的本地项目(各台机器上的同一个项目合成的那一行,连同并进来的)。 */
function projectIdsOfChat(chatId: string): readonly string[] {
  const row = projectGroupsStore.rowProjectOfChat(chatId) ?? projectGroupsStore.projectOfChat(chatId);
  return row ? sidebarStore.projectMembersOf(row) : [];
}

export function chatScope(anchor: InnerSidebarAnchor, summaries: ReadonlyMap<string, ChatSummary>): ChatAgentScope {
  const memberUserIds = summaries.get(anchor.chatId)?.memberUserIds ?? [];
  return anchor.kind === 'group'
    ? { kind: 'group', memberUserIds }
    : { kind: 'project', projectIds: projectIdsOfChat(anchor.chatId), memberUserIds };
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
      projectGroup: projectGroupsStore.rowProjectOfChat(chatId) !== undefined,
    };
  }
  if (currentViewId === 'project') {
    const projectId = (viewParamsStore.project as { projectId?: string } | undefined)?.projectId;
    return projectId ? { kind: 'project', chatId: projectGroupsStore.chatIdOf(sidebarStore.rowProjectIdOf(projectId)) } : { kind: 'other' };
  }
  if (currentViewId === 'session') {
    const sessionId = (viewParamsStore.session as { sessionId?: string } | undefined)?.sessionId;
    return sessionId ? { kind: 'session', sessionId } : { kind: 'other' };
  }
  return { kind: 'other' };
}

/**
 * 内层侧栏此刻挂在哪个对话上(没有 = null)。左边列表据此让那个群 / 项目那一行保持高亮 —— 从这一列点开一个智能体时,
 * 正看着的是那条会话,列表里却没有它自己的一行。
 */
export const innerSidebarChat = observable.box<InnerSidebarAnchor | null>(null, { deep: false });

/** 挂在工作区里,列表与对话之间(WorkspaceLayout 的 innerSidebar)。不该出现时什么都不画。 */
export const InnerSidebar = observer(function InnerSidebar() {
  const summaries = useChatSummaries();
  const agents = mySidebarAgents();
  const [anchor, setAnchor] = useState<InnerSidebarAnchor | null>(null);
  const view = currentView(summaries);
  const next = followInnerSidebar(anchor, view, (previous, sessionId) =>
    myAgentsInChat(agents, chatScope(previous, summaries)).some((entry) => entry.id === sessionId));
  // 上一次挂在哪是这一列自己记的(从这一列点开一个智能体,它还留着):换了才记,同一个对话不重设。
  if (next?.chatId !== anchor?.chatId || next?.kind !== anchor?.kind) setAnchor(next);
  // 换了对话就回到第一级(「全部」只对那一个对话)。
  useEffect(() => setInnerSidebarTopicsAll(null), [next?.chatId]);
  useEffect(() => runInAction(() => innerSidebarChat.set(next)), [next?.chatId, next?.kind]);
  // 壳据此收起对话页头上与这一列重复的按钮(成员、话题、邀请)。
  useEffect(() => publishInnerSidebarChat(next?.chatId ?? null), [next?.chatId]);
  const headActive = (view.kind === 'chat' || view.kind === 'project') && view.chatId === next?.chatId;

  return (
    <>
      <MyChatAgentCountsPublisher agents={agents} summaries={summaries} />
      {next ? (
        // 换一个对话 = 新的一列(收起、找的字都是这一个对话的);同一个对话里切「全部 / 返回」不重建,滚动位置留着。
        <InnerSidebarColumn
          key={next.chatId}
          anchor={next}
          summary={summaries.get(next.chatId) ?? null}
          headActive={headActive}
          agents={myAgentsInChat(agents, chatScope(next, summaries))}
        />
      ) : null}
    </>
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
    const chatId = projectGroupsStore.chatIdOf(ref.id);
    if (!chatId || counts.has(chatId)) continue;
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
  anchor: InnerSidebarAnchor;
  summary: ChatSummary | null;
  headActive: boolean;
  agents: readonly ChatAgentEntry[];
}) {
  const { translate } = useSessionMessages();
  const topicsAll = useInnerSidebarTopicsAll() === anchor.chatId;
  const topicsView = useInnerSidebarTopicsView(anchor.chatId);
  const [typed, setTyped] = useState('');
  const hasFilter = innerSidebarHasFilter({
    topics: topicsView?.total ?? 0,
    members: summary?.memberUserIds.length ?? 0,
    agents: agents.length,
  });
  const query = hasFilter ? typed.trim() : '';
  useEffect(() => {
    setInnerSidebarFilter(anchor.chatId, query);
    return () => setInnerSidebarFilter(anchor.chatId, '');
  }, [anchor.chatId, query]);
  // 第二级(全部话题)只在没在找时成立:找的时候本来就什么都不收。
  const levelTwo = topicsAll && !query;
  const topicsMatch = !query || topicsView === null || topicsView.matched > 0;
  const agentsMatch = !query || chatAgentsMatch(agents, query);
  const topics = topicsMatch ? <InnerTopicsSection chatId={anchor.chatId} levelTwo={levelTwo} query={query} view={topicsView} /> : null;
  const agentsSection = agentsMatch ? <InnerAgentsSection anchor={anchor} agents={agents} query={query} /> : null;
  return (
    // isolate:分区头、行里那几层 z 序关在这一列里,❌ 压过左边列表那根拖动分隔条。
    // 底色是正文的底色:这一列是叠在列表上那张卡片的左半(desktop-shell.css「叠一层」,#2548),❌ 侧栏那一档。
    <div
      data-region="inner-sidebar"
      data-inner-sidebar-chat={anchor.chatId}
      data-inner-sidebar-kind={anchor.kind}
      className="relative isolate flex h-full shrink-0 flex-col border-r border-border bg-background text-foreground-tertiary-muted"
      style={{ width: SIDEBAR_DEFAULT_WIDTH_PX }}
    >
      <SidebarSpace />
      <SidebarContainer className="min-h-0 w-full flex-1">
        <SidebarContent className="flex flex-col">
          <InnerHeadRow anchor={anchor} summary={summary} active={headActive} running={chatAgentCounts(agents).running} />
          {hasFilter ? (
            <SearchField
              className="mx-3 mb-2 w-auto shrink-0"
              data-inner-sidebar-filter=""
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              placeholder={translate('sidebar.innerFilter')}
              clearLabel={translate('sidebar.clearInnerFilter')}
              onClear={() => setTyped('')}
            />
          ) : null}
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
            {query && !topicsMatch && !agentsMatch ? (
              <div className="px-5 py-2 text-xs text-foreground-muted" data-inner-sidebar-empty="">
                {translate('sidebar.innerFilterEmpty', { query })}
              </div>
            ) : null}
          </div>
        </SidebarContent>
      </SidebarContainer>
    </div>
  );
});

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
      size={20}
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
 * 头一行就是这个群 / 项目自己:头像 + 名字,点它回到群聊(群聊开着时它是选中的)。行尾:未读(同项目行那个数)、
 * 「…」(悬停才出:群信息与设置、成员,项目再加项目那份菜单)、新智能体(常显)。两枚钮是「对话」分区头上那种钮。
 */
const InnerHeadRow = observer(function InnerHeadRow({
  anchor,
  summary,
  active,
  running,
}: {
  anchor: InnerSidebarAnchor;
  summary: ChatSummary | null;
  active: boolean;
  running: number;
}) {
  const { translate } = useSessionMessages();
  const { t } = useTranslation('messaging');
  const signals = useSidebarChatSignals();
  const [menuOpen, setMenuOpen] = useState(false);
  const { chatId } = anchor;
  const name = summary?.name ?? '';
  const rowProjectId = anchor.kind === 'project' ? projectGroupsStore.rowProjectOfChat(chatId) ?? projectGroupsStore.projectOfChat(chatId) : undefined;
  // 项目行挂的是项目群的未读(含叫到你的话题);用户群挂它自己的未读,同聊天列表那一行。
  const unread = anchor.kind === 'project' ? signals?.groupUnread.get(chatId) ?? 0 : summary?.unreadCount ?? 0;
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
  const avatar: ReactNode = rowProjectId ? (
    <ProjectFolderAvatar coverId={rowProjectId} running={running} size={20} />
  ) : (
    <GroupHeadAvatar chatId={chatId} summary={summary} />
  );
  return (
    <SidebarMenu className="shrink-0 pt-2 pb-1">
      <div className="group/head relative" data-inner-head={chatId}>
        <SidebarMenuButton isActive={active} aria-label={name} className="w-full pr-16" onClick={() => openChatOnScreen(chatId, false)}>
          <span className={cn('flex min-w-0 items-center gap-2', sidebarRowContentInsetX)}>
            <span className="flex size-5 shrink-0 items-center justify-center">{avatar}</span>
            <span className="truncate font-semibold text-foreground">{name}</span>
          </span>
        </SidebarMenuButton>
        <span className="absolute inset-y-0 right-2 flex items-center">
          <SidebarUnreadCount count={unread} />
          <DropdownMenu.Root open={menuOpen} modal={false} onOpenChange={setMenuOpen}>
            <Tooltip>
              <DropdownMenu.Trigger
                render={
                  <TooltipTrigger
                    render={
                      <button
                        type="button"
                        aria-label={actionsLabel}
                        data-inner-head-actions=""
                        className={cn(
                          sidebarHeaderIconButtonClass,
                          'opacity-0 transition-opacity group-hover/head:opacity-100 focus-visible:opacity-100 aria-expanded:opacity-100'
                        )}
                      >
                        <MoreHorizontal />
                      </button>
                    }
                  />
                }
              />
              <TooltipContent>{actionsLabel}</TooltipContent>
            </Tooltip>
            {menuOpen ? (
              <DropdownMenu.Content side="bottom" align="end" sideOffset={4} className="min-w-44">
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
              </DropdownMenu.Content>
            ) : null}
          </DropdownMenu.Root>
          <Tooltip>
            <TooltipTrigger
              render={
                <button type="button" aria-label={newAgentLabel} data-inner-head-new-agent="" className={sidebarHeaderIconButtonClass} onClick={newAgent}>
                  <SquarePen />
                </button>
              }
            />
            <TooltipContent>{newAgentLabel}</TooltipContent>
          </Tooltip>
        </span>
      </div>
    </SidebarMenu>
  );
});

/** 分区头:贴在滚动区顶上(往下滚时还看得见是哪一段)。 */
const stickyHeaderClass = cn(sidebarGroupHeaderClass, 'sticky top-0 z-10 bg-background');

function InnerTopicsSection({
  chatId,
  levelTwo,
  query,
  view,
}: {
  chatId: string;
  levelTwo: boolean;
  query: string;
  view: InnerSidebarTopicsView | null;
}) {
  const { translate } = useSessionMessages();
  const [collapsed, setCollapsed] = useState(false);
  const slot = useCallback(
    (element: HTMLDivElement | null) => readShellSlots()?.setSlot(innerSidebarTopicsSlotKey(chatId), element),
    [chatId]
  );
  const canDrill = !query && (levelTwo || (view?.hidden ?? 0) > 0);
  return (
    <SidebarGroup className="mb-2 flex shrink-0 flex-col" data-inner-sidebar-section="topics">
      <div className={stickyHeaderClass}>
        <span className="flex items-center gap-1">
          <SidebarGroupToggle
            label={translate('sidebar.topics')}
            count={0}
            collapsed={collapsed}
            onToggle={() => setCollapsed((value) => !value)}
            ariaLabel={translate(collapsed ? 'sidebar.expandTopics' : 'sidebar.collapseTopics')}
          />
          {view && view.total > 0 ? <span className={sidebarCountClass}>{query ? view.matched : view.total}</span> : null}
          {/* 收起时标题旁挂里面叫到你的(同「对话」分区头那个未读数)。 */}
          {collapsed ? <SidebarUnreadCount count={view?.calling ?? 0} /> : null}
        </span>
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
          {!levelTwo && !query && view && view.hidden > 0 ? (
            <SidebarMoreRow
              foldKey={`chat:${chatId}:topics`}
              expanded={false}
              hiddenCount={view.hidden}
              label={translate('sidebar.allTopicsCount', { count: view.total })}
              onToggle={() => setInnerSidebarTopicsAll(chatId)}
            />
          ) : null}
        </SidebarMenu>
      )}
      {!collapsed && view?.total === 0 ? (
        <div className="px-5 pb-2 text-xs text-foreground-muted">{translate('sidebar.noTopics')}</div>
      ) : null}
    </SidebarGroup>
  );
}

const InnerAgentsSection = observer(function InnerAgentsSection({
  anchor,
  agents,
  query,
}: {
  anchor: InnerSidebarAnchor;
  agents: readonly ChatAgentEntry[];
  query: string;
}) {
  const { translate } = useSessionMessages();
  const [collapsed, setCollapsed] = useState(false);
  // 「还有 N 个在运行」「展开显示」点开了没有,记在侧栏同一张表里,键与项目 / 任务分区分开。
  const restKey = `chat:${anchor.chatId}`;
  const runningKey = `chat:${anchor.chatId}:running`;
  const groups = chatAgentSection(agents, {
    expanded: sidebarStore.expandedSessionIds,
    showAllRunning: sidebarStore.idleExpandedProjectIds.has(runningKey),
    showAllRest: sidebarStore.idleExpandedProjectIds.has(restKey),
    query,
  });
  const counts = chatAgentCounts(agents);
  const countLabel = [
    translate('sidebar.agentCount', { count: counts.total }),
    ...(counts.running > 0 ? [translate('sidebar.agentsRunning', { count: counts.running })] : []),
  ].join(', ');
  return (
    <SidebarGroup className="mb-2 flex shrink-0 flex-col" data-inner-sidebar-section="agents">
      <div className={stickyHeaderClass}>
        <span className="flex items-center gap-1">
          <SidebarGroupToggle
            label={translate(anchor.kind === 'group' ? 'sidebar.myAgents' : 'sidebar.agents')}
            count={0}
            collapsed={collapsed}
            onToggle={() => setCollapsed((value) => !value)}
            ariaLabel={translate(collapsed ? 'sidebar.expandAgents' : 'sidebar.collapseAgents')}
          />
          {/* 药丸收起时也在:总数(连子会话) | 在跑的。 */}
          {counts.total > 0 ? <SidebarSessionBranchCount summary={chatAgentPill(agents)} expanded={false} label={countLabel} /> : null}
          {collapsed ? <SidebarUnreadCount count={chatAgentNeedsYou(agents)} /> : null}
        </span>
      </div>
      {collapsed ? null : counts.total === 0 ? (
        <div className="px-5 pb-2 text-xs text-foreground-muted">{translate('sidebar.noAgents')}</div>
      ) : (
        <SidebarMenu className="pb-1">
          {groups.map(({ group, rows, overflow, total }) => (
            <div key={group ?? 'rest'} data-agent-group={group ?? 'rest'}>
              {group ? (
                <div className="h-6">
                  <SidebarStateHeader group={group} count={total} variant="section" />
                </div>
              ) : null}
              {rows.map((row) => (
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
              {overflow > 0 ? (
                group === 'working' ? (
                  <SidebarMoreRow
                    foldKey={runningKey}
                    expanded={sidebarStore.idleExpandedProjectIds.has(runningKey)}
                    hiddenCount={overflow}
                    label={translate('sidebar.moreRunning', { count: overflow })}
                  />
                ) : (
                  <SidebarMoreRow foldKey={restKey} expanded={sidebarStore.idleExpandedProjectIds.has(restKey)} hiddenCount={overflow} />
                )
              ) : null}
            </div>
          ))}
        </SidebarMenu>
      )}
    </SidebarGroup>
  );
});
