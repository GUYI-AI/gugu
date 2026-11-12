import { ChevronLeft, ChevronRight } from '@/lib/icons';
import { observable, runInAction } from 'mobx';
import { observer } from 'mobx-react-lite';
import { useCallback, useEffect, useState } from 'react';
import { useChatSummaries, type ChatSummary } from '@/lib/chatSummariesBridge';
import {
  innerSidebarTopicsSlotKey,
  publishMyChatAgentCounts,
  setInnerSidebarTopicsAll,
  useInnerSidebarTopicsAll,
  useInnerSidebarTopicsView,
  type ChatAgentCounts,
} from '@/lib/innerSidebarBridge';
import { readShellSlots } from '@/lib/shellSlots';
import { projectGroupsStore } from '@renderer/features/projects/stores/project-groups-store';
import { sessionAgentBindings } from '@renderer/features/sessions/stores/session-agent-bindings';
import { useAppSettingsKey } from '@renderer/features/settings/use-app-settings-key';
import { SIDEBAR_DEFAULT_WIDTH_PX } from '@renderer/lib/layout/layout-provider';
import { appState, sidebarStore } from '@renderer/lib/stores/app-state';
import { Button } from '@renderer/lib/ui/button';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import {
  chatAgentCounts,
  chatAgentPill,
  chatAgentSection,
  myAgentsInChat,
  type ChatAgentEntry,
  type ChatAgentScope,
} from './chat-agents';
import { followInnerSidebar, type InnerSidebarAnchor, type InnerSidebarView } from './inner-sidebar-anchor';
import { SidebarGroupToggle } from './sidebar-group-toggle';
import { SidebarMoreRow } from './sidebar-more-row';
import {
  SidebarContainer,
  SidebarContent,
  SidebarGroup,
  SidebarMenu,
  sidebarCountClass,
  sidebarGroupHeaderClass,
} from './sidebar-primitives';
import { SidebarSessionBranchCount } from './sidebar-session-branch-view';
import { SidebarSessionItem } from './sidebar-session-item';
import { SidebarSpace } from './sidebar-space';
import { SidebarStateHeader } from './sidebar-state-header';

// #2548 内层侧栏:桌面上打开一个用户群或一个项目时,左边列表与对话之间多出来的一列(开关 interface.desktopSidebarV2,
// 关着 = 什么都不变;手机永不出现)。分区顺序:群里「话题」在上、「我的智能体」在下;项目里「智能体」在上、「话题」在下。
// 手机永不出现是结构上的:这一列住在会话页的工作区里,手机壳不画工作区(check-ui-visual-spec 守着「任务渲染层只在桌面」)。
// 这一列只重排现有的组件:分区头是侧栏分区头,智能体行是任务区那一行(SidebarSessionItem),话题行是聊天列表里
// 嵌在群下面的那一行 —— 由壳画进「话题」那一格(components/ChatListSlotHost.tsx → InnerSidebarTopics)。

/** 侧栏里我的每一条会话,带上它背后的 agent(同 SidebarSessionItem 认身份的两条腿)。 */
function mySidebarAgents(): ChatAgentEntry[] {
  return [...sidebarStore.placement.nodeById.values()].map(({ item }) => ({
    id: item.id,
    projectId: item.projectId,
    parentSessionId: item.parentSessionId,
    isPinned: item.isPinned,
    time: item.time,
    presentation: item.presentation,
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

function chatScope(anchor: InnerSidebarAnchor, summaries: ReadonlyMap<string, ChatSummary>): ChatAgentScope {
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
  const { value: interfaceSettings } = useAppSettingsKey('interface');
  const enabled = interfaceSettings?.desktopSidebarV2 === true;
  const summaries = useChatSummaries();
  const agents = enabled ? mySidebarAgents() : [];
  const [anchor, setAnchor] = useState<InnerSidebarAnchor | null>(null);
  const next = enabled
    ? followInnerSidebar(anchor, currentView(summaries), (previous, sessionId) =>
        myAgentsInChat(agents, chatScope(previous, summaries)).some((entry) => entry.id === sessionId))
    : null;
  // 上一次挂在哪是这一列自己记的(从这一列点开一个智能体,它还留着):换了才记,同一个对话不重设。
  if (next?.chatId !== anchor?.chatId || next?.kind !== anchor?.kind) setAnchor(next);
  // 换了对话就回到第一级(「全部」只对那一个对话)。
  useEffect(() => setInnerSidebarTopicsAll(null), [next?.chatId]);
  useEffect(() => runInAction(() => innerSidebarChat.set(next)), [next?.chatId, next?.kind]);

  return (
    <>
      <MyChatAgentCountsPublisher enabled={enabled} agents={agents} summaries={summaries} />
      {next ? <InnerSidebarColumn anchor={next} agents={myAgentsInChat(agents, chatScope(next, summaries))} /> : null}
    </>
  );
});

/** 项目行头像角上那个数(#2548):每个项目群里我的智能体,与分区头同一个推导。开关关着发一份空的。 */
const MyChatAgentCountsPublisher = observer(function MyChatAgentCountsPublisher({
  enabled,
  agents,
  summaries,
}: {
  enabled: boolean;
  agents: readonly ChatAgentEntry[];
  summaries: ReadonlyMap<string, ChatSummary>;
}) {
  const counts = new Map<string, ChatAgentCounts>();
  if (enabled) {
    for (const ref of sidebarStore.sidebarProjects) {
      const chatId = projectGroupsStore.chatIdOf(ref.id);
      if (!chatId || counts.has(chatId)) continue;
      counts.set(chatId, chatAgentCounts(myAgentsInChat(agents, chatScope({ kind: 'project', chatId }, summaries))));
    }
  }
  // 依赖是序列化后的数:每次渲染新建的 Map 不算变化(publish 自己也只在数变了时才通知)。
  const key = JSON.stringify([...counts]);
  useEffect(() => publishMyChatAgentCounts(counts), [key]);
  return null;
});

const InnerSidebarColumn = observer(function InnerSidebarColumn({
  anchor,
  agents,
}: {
  anchor: InnerSidebarAnchor;
  agents: readonly ChatAgentEntry[];
}) {
  const topicsAll = useInnerSidebarTopicsAll() === anchor.chatId;
  const topics = <InnerTopicsSection chatId={anchor.chatId} all={topicsAll} />;
  const agentsSection = <InnerAgentsSection anchor={anchor} agents={agents} />;
  return (
    // isolate:分区头、行里那几层 z 序关在这一列里,❌ 压过左边列表那根拖动分隔条。
    <div
      data-region="inner-sidebar"
      data-inner-sidebar-chat={anchor.chatId}
      data-inner-sidebar-kind={anchor.kind}
      className="relative isolate flex h-full shrink-0 flex-col border-r border-border bg-background-tertiary text-foreground-tertiary-muted"
      style={{ width: SIDEBAR_DEFAULT_WIDTH_PX }}
    >
      <SidebarSpace />
      <SidebarContainer className="min-h-0 w-full flex-1">
        <SidebarContent className="flex flex-col">
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
                {topicsAll ? null : agentsSection}
              </>
            )}
          </div>
        </SidebarContent>
      </SidebarContainer>
    </div>
  );
});

function InnerTopicsSection({ chatId, all }: { chatId: string; all: boolean }) {
  const { translate } = useSessionMessages();
  const view = useInnerSidebarTopicsView(chatId);
  const [collapsed, setCollapsed] = useState(false);
  const slot = useCallback(
    (element: HTMLDivElement | null) => readShellSlots()?.setSlot(innerSidebarTopicsSlotKey(chatId), element),
    [chatId]
  );
  const canDrill = all || (view?.hidden ?? 0) > 0;
  return (
    <SidebarGroup className="mb-2 flex shrink-0 flex-col" data-inner-sidebar-section="topics">
      <div className={sidebarGroupHeaderClass}>
        <span className="flex items-center gap-1">
          <SidebarGroupToggle
            label={translate('sidebar.topics')}
            count={0}
            collapsed={collapsed}
            onToggle={() => setCollapsed((value) => !value)}
            ariaLabel={translate(collapsed ? 'sidebar.expandTopics' : 'sidebar.collapseTopics')}
          />
          {view && view.total > 0 ? <span className={sidebarCountClass}>{view.total}</span> : null}
        </span>
        {!collapsed && canDrill ? (
          <Button
            variant="ghost"
            size="xs"
            data-inner-topics-drill={all ? 'back' : 'all'}
            onClick={() => setInnerSidebarTopicsAll(all ? null : chatId)}
          >
            {all ? (
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
        <div className="px-5 pb-2 text-xs text-foreground-muted">{translate('sidebar.noTopics')}</div>
      ) : null}
    </SidebarGroup>
  );
}

const InnerAgentsSection = observer(function InnerAgentsSection({
  anchor,
  agents,
}: {
  anchor: InnerSidebarAnchor;
  agents: readonly ChatAgentEntry[];
}) {
  const { translate } = useSessionMessages();
  const [collapsed, setCollapsed] = useState(false);
  // 「展开显示」记在侧栏同一张表里,键与项目 / 任务分区分开。
  const foldKey = `chat:${anchor.chatId}`;
  const idleExpanded = sidebarStore.idleExpandedProjectIds.has(foldKey);
  const section = chatAgentSection(agents, { expanded: sidebarStore.expandedSessionIds, idleExpanded });
  const counts = chatAgentCounts(agents);
  const countLabel = [
    translate('sidebar.agentCount', { count: counts.total }),
    ...(counts.running > 0 ? [translate('sidebar.agentsRunning', { count: counts.running })] : []),
  ].join(', ');
  return (
    <SidebarGroup className="mb-2 flex shrink-0 flex-col" data-inner-sidebar-section="agents">
      <div className={sidebarGroupHeaderClass}>
        <span className="flex items-center gap-1">
          <SidebarGroupToggle
            label={translate(anchor.kind === 'group' ? 'sidebar.myAgents' : 'sidebar.agents')}
            count={0}
            collapsed={collapsed}
            onToggle={() => setCollapsed((value) => !value)}
            ariaLabel={translate(collapsed ? 'sidebar.expandAgents' : 'sidebar.collapseAgents')}
          />
          {counts.total > 0 ? <SidebarSessionBranchCount summary={chatAgentPill(agents)} expanded={false} label={countLabel} /> : null}
        </span>
      </div>
      {collapsed ? null : counts.total === 0 ? (
        <div className="px-5 pb-2 text-xs text-foreground-muted">{translate('sidebar.noAgents')}</div>
      ) : (
        <SidebarMenu className="pb-1">
          {section.groups.map(({ group, rows }) => (
            <div key={group ?? 'idle'}>
              {group ? (
                <div className="h-6">
                  <SidebarStateHeader group={group} count={rows.length} variant="section" />
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
                />
              ))}
            </div>
          ))}
          {section.folded > 0 ? <SidebarMoreRow foldKey={foldKey} expanded={idleExpanded} hiddenCount={section.folded} /> : null}
        </SidebarMenu>
      )}
    </SidebarGroup>
  );
});
