import { columnAgents } from './inner-sidebar-column';
import { ChevronLeft, ChevronRight } from '@/lib/icons';
import { observable, runInAction } from 'mobx';
import { observer } from 'mobx-react-lite';
import { useCallback, useEffect, useLayoutEffect, type ReactNode } from 'react';
import { Avatar } from '@/components/Avatar';
import { ListColumnToggle } from '@/components/PanelToggleButtons';
import { useChatSummaries, type ChatSummary } from '@/lib/chatSummariesBridge';
import { setComposerVerb } from '@/lib/composerVerbBridge';
import {
  innerSidebarTopicsSlotKey,
  publishInnerSidebarPresent,
  setInnerSidebarTopicsAll,
  useInnerSidebarTopicsAll,
  useInnerSidebarTopicsView,
  type InnerSidebarTopicsView,
} from '@/lib/innerSidebarBridge';
import { publishPanelToggle } from '@/lib/panelToggles';
import { readShellSlots } from '@/lib/shellSlots';
import { chatBlockOnScreen } from '@renderer/features/chats/group-participant-actions';
import { screenLayout } from '@renderer/app/screen-layout';
import { navigateToGroupRoot } from '@renderer/app/screen-layout-actions';
import { prepareProjectTask } from '@renderer/features/projects/project-task-entry';
import { accountProjectsStore } from '@renderer/features/projects/stores/account-projects-store';
import { sampleProjectInView } from '@renderer/features/sample-project/sample-project-view';
import { useSampleProject } from '@renderer/features/sample-project/use-sample-project';
import { useInnerSidebarCrowded, useInnerSidebarFrame } from '@renderer/lib/layout/layout-provider';
import { ShellRestoreLane } from '@renderer/lib/components/titlebar/shell-restore-lane';
import { appState, sidebarStore } from '@renderer/lib/stores/app-state';
import { Button } from '@renderer/lib/ui/button';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import {
  chatAgentCounts,
  chatAgentNeedsYou,
  chatAgentSection,
  openSessionAncestors,
  type ChatAgentEntry,
} from './chat-agents';
import {
  followInnerSidebar,
  innerSidebarChat,
  type InnerSidebarRoomAnchor,
  type InnerSidebarView,
} from './inner-sidebar-anchor';
import { innerSidebarFolded, innerSidebarFoldedAway, setInnerSidebarCrowded, setInnerSidebarFolded } from './inner-sidebar-fold';
import { chatScope, chatViewOf, isProjectChat, listedProjectIds, roomOfEntry, sidebarFamilies } from './inner-sidebar-scope';
import { setSidebarFold, sidebarFolds } from './sidebar-folds';
import {
  InnerHeadRowLayout,
  InnerSidebarFoldButton,
  innerSectionEmptyClass,
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
  sidebarGroupHeaderClass,
} from './sidebar-primitives';
import { sessionDropTarget } from './session-drop-target';
import { moveSessionUnder } from '@renderer/features/sessions/set-session-parent-flow';
import { SampleInnerSidebar } from './sample-inner-sidebar';
import { SidebarSessionItem } from './sidebar-session-item';

// #2548 内层侧栏:桌面上打开一个用户群或一个项目时,左边列表与对话之间多出来的一列(手机永不出现)。分区顺序:群里「话题」在上、「我的智能体」在下;项目里「智能体」在上、「话题」在下。
// 私聊(连派过子会话的智能体)没有这一列(推翻 #2574):子会话从它的详情页进。
// 手机永不出现是结构上的:这一列住在会话页的工作区里,手机壳不画工作区(check-ui-visual-spec 守着「任务渲染层只在桌面」)。
// 这一列只重排现有的组件:头一行是侧栏顶上那几行动作行(SidebarMenuButton)画这个群 / 项目自己,分区头是侧栏分区头,
// 智能体行是任务区那一行(SidebarSessionItem,行首换成 agent 自己的头像:agentAvatar),话题行由壳画进「话题」那一格(components/ChatListSlotHost.tsx →
// InnerSidebarTopics,同一个动作行的样子)。这一列里 ❌ 找的框:找东西用列表顶上那个搜索(开着群时先搜这个群,sidebar-search-trigger)。
// 这一列可以收起(inner-sidebar-fold):收起是全局的,正文左上角浮出展开钮(InnerSidebarRestore)。

/** 导航此刻在哪(读成内层侧栏要的样子)。 */
function currentView(summaries: ReadonlyMap<string, ChatSummary>): InnerSidebarView {
  const { currentViewId, viewParamsStore } = appState.navigation;
  if (currentViewId === 'chat') {
    const chatId = (viewParamsStore.chat as { chatId?: string } | undefined)?.chatId;
    if (!chatId) return { kind: 'other' };
    return chatViewOf(chatId, summaries);
  }
  if (currentViewId === 'project') {
    const projectId = (viewParamsStore.project as { projectId?: string } | undefined)?.projectId;
    return projectId ? { kind: 'project', chatId: accountProjectsStore.projectOfLocal(projectId)?.chatId } : { kind: 'other' };
  }
  if (currentViewId === 'session') {
    const sessionId = openSessionId();
    return sessionId ? { kind: 'session', sessionId } : { kind: 'other' };
  }
  return { kind: 'other' };
}

/** 主区此刻打开着的会话(不在会话页 = null)。 */
function openSessionId(): string | null {
  const { currentViewId, viewParamsStore } = appState.navigation;
  if (currentViewId !== 'session') return null;
  return (viewParamsStore.session as { sessionId?: string } | undefined)?.sessionId ?? null;
}

// 它住在 inner-sidebar-anchor(轻,列表顶上的搜索也读它);从这里照旧拿得到。
export { innerSidebarChat };
export { chatScope, isProjectChat, listedProjectIds, mySidebarAgents } from './inner-sidebar-scope';

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
  const families = sidebarFamilies.get();
  const agents = families.entries;
  const view = currentView(summaries);
  // 这一屏挂在哪,只认这一屏自己记着的入口(screen-layout `entry`):从群 / 项目里点开的智能体、切走再回来摆回的那一屏,都挂回那个群。
  const next = followInnerSidebar(
    roomOfEntry(screenLayout.currentEntry, summaries),
    view,
    (anchor, sessionId) => columnAgents(anchor, families, summaries, null, chatScope).some((agent) => agent.id === sessionId),
    () => null,
    (anchor) => chatBlockOnScreen(anchor.chatId) !== undefined
  );
  // 换了对话就回到第一级(「全部」只对那一个对话)。
  useEffect(() => setInnerSidebarTopicsAll(null), [next?.chatId]);
  useEffect(() => runInAction(() => innerSidebarChat.set(next)), [next?.chatId, next?.kind]);
  // 壳据此收起群页头上与这一列重复的话题钮(每一块都收:按到哪一块,这一列就挂过去)。
  useEffect(() => {
    publishInnerSidebarPresent(true);
    return () => publishInnerSidebarPresent(false);
  }, []);
  // 头一行是这一列自己:群 / 项目开着它的对话时。
  const headActive = (view.kind === 'chat' || view.kind === 'project') && view.chatId === next?.chatId;
  // 示例项目(#709)那一块正看着:这一列画示例自己(打包在 app 里的内容,❌ 群、❌ 网络)。它不是哪一个对话,所以 ❌ 进 innerSidebarChat;
  // 账号上的键说它不在了(刚移除),这一列跟那一行同时收。
  const sample = useSampleProject();
  const sampleOwnerId = next === null && sample.shown && sampleProjectInView() ? sample.owner?.id : undefined;
  const attachedTo = next?.chatId ?? (sampleOwnerId ? 'sample' : null);
  // 收起着:这一列照旧挂着(收起是它的格子合到 0,@@@panel-track),挂在哪照旧跟着(左边那一行照旧亮着、壳照旧收起页头上与它重复的钮),正文左上角浮出展开钮。
  const crowded = useInnerSidebarCrowded();
  useLayoutEffect(() => setInnerSidebarCrowded(crowded), [crowded]);
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
      {next ? (
        // 换一个对话 = 新的一列(分区收起都是这一个对话的);同一个对话里切「全部 / 返回」不重建,滚动位置留着。
        <InnerSidebarColumn
          key={next.chatId}
          anchor={next}
          summary={summaries.get(next.chatId) ?? null}
          headActive={headActive}
          agents={columnAgents(next, families, summaries, null, chatScope)}
        />
      ) : sampleOwnerId ? (
        <InnerSidebarFrame kind="sample">
          <SampleInnerSidebar />
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
      <InnerHeadRow anchor={anchor} summary={summary} active={headActive} />
      <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto" data-region="inner-sidebar-scroll">
        {/* 群、项目同一个次序(第 16 版稿):「话题」在上、「智能体」在下。第二级(全部话题)收走下面的「智能体」,「全部 › / ‹ 返回」因此永远在同一个位置。 */}
        {topics}
        {levelTwo ? null : agentsSection}
      </div>
    </InnerSidebarFrame>
  );
});

/**
 * 这一列本身(群 / 项目 / 示例都是它):列表与正文之间的一列;里面是头一行(这一列顶上那条带)与分区。
 * 宽度由工作区的那一格给(PanelSlot「inner」,拖它右边缘调 #2642),这一列只铺满它;收起时它照旧挂着,只报给那一格。
 */
const InnerSidebarFrame = observer(function InnerSidebarFrame({
  kind,
  chatId,
  children,
}: {
  kind: InnerSidebarRoomAnchor['kind'] | 'sample';
  chatId?: string;
  children: ReactNode;
}) {
  useInnerSidebarFrame(innerSidebarFolded.get());
  return (
    // isolate:分区头、行里那几层 z 序关在这一列里,❌ 压过左边列表那根拖动分隔条。
    // 底色是窗口底(同 left-sidebar,界面减法 #10):这一列归列表那一层,只有正文是叠在上面的卡片;左边一根细线和零级栏分开(#52)。
    <div
      data-region="inner-sidebar"
      data-inner-sidebar-chat={chatId}
      data-inner-sidebar-kind={kind}
      className="relative isolate flex h-full w-full flex-col border-l border-border text-foreground-tertiary-muted"
    >
      <SidebarContainer className="min-h-0 w-full flex-1">
        <SidebarContent className="flex flex-col">{children}</SidebarContent>
      </SidebarContainer>
    </div>
  );
});

/** 群或项目的脸:自己设的头像,没设就是默认头像(同聊天列表那一行)。 */
function GroupHeadAvatar({ chatId, summary }: { chatId: string; summary: ChatSummary | null }) {
  return <Avatar name={summary?.name ?? ''} avatarUrl={summary?.avatar} seed={chatId} size={40} variant="group" />;
}

/**
 * 头一行就是这个群 / 项目自己:头像 + 名字,点它回到它的主群聊(owner 11-14)。
 * 第二行直接在群 / 项目里创建智能体;收起按钮常驻在块外最右。❌ 悬停「⋯」(第 16 版稿):群的那些项在详情页里。
 * 项目那份菜单在项目页签的右键里。
 * ❌ 未读数(#2548 提议稿 state0):这个群的数挂在左边列表它那一行上(叫到你的才是红数,其余一颗灰点),这里再挂一份就是两处。
 */
const InnerHeadRow = observer(function InnerHeadRow({
  anchor,
  summary,
  active,
}: {
  anchor: InnerSidebarRoomAnchor;
  summary: ChatSummary | null;
  active: boolean;
}) {
  const { translate } = useSessionMessages();
  const { chatId } = anchor;
  const name = summary?.name ?? '';
  // 项目的代表本地项目(与侧栏那一行同一个);一个文件夹都没有的项目没有 —— 新智能体走群那一条,封面按群取色(同 partnerProjects)。
  const rowProjectId = anchor.kind === 'project' ? accountProjectsStore.representativeOf(chatId) : undefined;
  // 同输入框「+」右边那个「新任务」:项目走项目行「+」那一条(prepareProjectTask),群把这个群的框换成新任务;都回到群本身(navigateToGroupRoot)。
  const newAgent = () => {
    if (rowProjectId) prepareProjectTask(rowProjectId);
    else setComposerVerb(chatId, 'task', '', { name, joinable: true, inGroup: true });
    navigateToGroupRoot(chatId);
  };
  // #2600 项目群和别的群一样戴群自己的头像(没设 = 成员拼图),❌ 文件夹封面。
  const avatar: ReactNode = <GroupHeadAvatar chatId={chatId} summary={summary} />;
  return (
    <InnerHeadRowLayout headKey={chatId} name={name} avatar={avatar} active={active} onOpen={() => navigateToGroupRoot(chatId)} trailingButtons={1}
      createAction={{ label: translate('sidebar.createAgent'), onClick: newAgent }}>
      <InnerSidebarFoldButton />
    </InnerHeadRowLayout>
  );
});

const InnerTopicsSection = observer(function InnerTopicsSection({ chatId, levelTwo, view }: { chatId: string; levelTwo: boolean; view: InnerSidebarTopicsView | null }) {
  const { translate } = useSessionMessages();
  const collapsed = sidebarFolds.has('inner:topics');
  const slot = useCallback(
    (element: HTMLDivElement | null) => readShellSlots()?.setSlot(innerSidebarTopicsSlotKey(chatId), element),
    [chatId]
  );
  const canDrill = levelTwo || (view?.hidden ?? 0) > 0;
  return (
    <SidebarGroup className="mb-2 flex shrink-0 flex-col" data-inner-sidebar-section="topics">
      <div className={sidebarGroupHeaderClass}>
        <span className="flex items-center gap-1">
          <SidebarGroupToggle
            label={translate('sidebar.topics')}
            count={0}
            collapsed={collapsed}
            onToggle={() => setSidebarFold('inner:topics', !collapsed)}
            ariaLabel={translate(collapsed ? 'sidebar.expandTopics' : 'sidebar.collapseTopics')}
          />
          {/* 稿子上没有话题也写「0」。 */}
          {view ? <span className={sidebarCountClass}>{view.total}</span> : null}
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
        <SidebarMenu data-inner-rows="">
          <div ref={slot} data-region="inner-sidebar-topics" className="min-h-0" />
        </SidebarMenu>
      )}
      {!collapsed && view?.total === 0 ? (
        <div className={innerSectionEmptyClass}>{translate('sidebar.noTopics')}</div>
      ) : null}
    </SidebarGroup>
  );
});

/**
 * 「智能体」:标题旁 ❌ 数(第 16 版稿只有「话题」挂数),❌ 药丸、❌「需要你 / 运行中」组头(#2548 ⑥):一张平的表(chatAgentSection),
 * 按最近的动静排,状态只看行尾那几个记号。群里也只列我的,标题照样写「智能体」(owner 11-12)。
 */
const InnerAgentsSection = observer(function InnerAgentsSection({ anchor, agents }: { anchor: InnerSidebarRoomAnchor; agents: readonly ChatAgentEntry[] }) {
  const { translate } = useSessionMessages();
  const collapsed = sidebarFolds.has('inner:agents');
  // 「展开显示」点开了没有,记在侧栏同一张表里,键与项目 / 任务分区分开。
  const foldKey = `chat:${anchor.chatId}`;
  const showAll = sidebarStore.idleExpandedProjectIds.has(foldKey);
  // 主区打开着的会话(#2630):它的家族 ❌ 收进「展开显示」;是子会话就把它上面几层展开一次(之后照样能手动收起)。
  const open = openSessionId();
  const ancestorsKey = openSessionAncestors(agents, open).join(',');
  useEffect(() => {
    if (ancestorsKey) sidebarStore.expandSessions(ancestorsKey.split(','));
  }, [ancestorsKey]);
  const list = chatAgentSection(agents, { expanded: sidebarStore.expandedSessionIds, showAll, open });
  const total = chatAgentCounts(agents).total;
  // A sub-session of this list dragged onto the section header goes back to the top level (spec session-page「把会话拖成 child」).
  const unnestHere = sessionDropTarget(
    (dragged) => sidebarStore.parentOf(dragged.sessionId) !== null && agents.some((agent) => agent.id === dragged.sessionId),
    (child) => moveSessionUnder(child, null, sidebarStore.parentOf(child.sessionId))
  );
  return (
    <SidebarGroup className="mb-2 flex shrink-0 flex-col" data-inner-sidebar-section="agents">
      <div className={sidebarGroupHeaderClass} {...unnestHere}>
        <span className="flex items-center gap-1">
          <SidebarGroupToggle
            label={translate('sidebar.agents')}
            count={0}
            collapsed={collapsed}
            onToggle={() => setSidebarFold('inner:agents', !collapsed)}
            ariaLabel={translate(collapsed ? 'sidebar.expandAgents' : 'sidebar.collapseAgents')}
          />
          {collapsed ? <SidebarUnreadCount count={chatAgentNeedsYou(agents)} /> : null}
        </span>
      </div>
      {collapsed ? null : total === 0 ? (
        <div className={innerSectionEmptyClass}>{translate('sidebar.noAgents')}</div>
      ) : (
        <SidebarMenu className="pb-1" data-inner-rows="">
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
