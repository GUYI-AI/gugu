import { Clock, FolderInput } from '@/lib/icons'
import { observer } from 'mobx-react-lite';
import React from 'react';
import { sessionAgentBindings } from '@renderer/features/sessions/stores/session-agent-bindings';
import { remoteHostsStore } from '@renderer/features/remote-hosts/remote-hosts-store';
import { useAssistantShell } from '@renderer/features/assistant/assistant-shell';
import { isAssistantAgent } from '@renderer/features/assistant/assistant-lineage';
import { useAppSettingsKey } from '@renderer/features/settings/use-app-settings-key';
import { useLeftRailLayout, useWorkspaceLayoutContext } from '@renderer/lib/layout/layout-provider';
import { isCurrentView, useNavigate, useWorkspaceSlots } from '@renderer/lib/layout/navigation-provider';
import { appState, sidebarStore } from '@renderer/lib/stores/app-state';
import { cn } from '@renderer/utils/utils';
import { SidebarContainer, SidebarContent, SidebarMenu, SidebarMenuButton, sidebarRowContentInsetX } from './sidebar-primitives';
import { sessionKeyboardNav } from './session-keyboard-nav';
import { publishSidebarChatView, setSidebarNotificationsOpen, useSidebarNotificationsOpen } from '@/lib/sidebarChatsBridge';
import { NotificationSlot } from '@/components/needsYou/NotificationSlot';
import { RETAINED_SURFACE_HIDDEN_STYLE } from '@/lib/retainedSurface';
import { SidebarOneListEmpty } from './sidebar-one-list-empty';
import { useSidebarDrop } from './use-sidebar-drop';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { useNativeConversationChat } from '@/hooks/useNativeConversationChat';
import { screenLayout } from '@renderer/app/screen-layout';
import { SidebarOneList } from './sidebar-one-list';
import { innerSidebarChat, innerSidebarShownFor } from './inner-sidebar';
import { ONE_LIST_RAIL_PX, SidebarOneListHead, SidebarOneListTop } from './sidebar-one-list-chrome';

// #2548 the desktop left sidebar, one list: the head (collapse, bell, search, 会话历史), 创建智能体 + 「+」, then ONE list
// (SidebarOneList) down to the window's bottom edge (sidebar-one-list-chrome); 已安排 in the bell's panel. 资源库 and 设置
// are on the far-left rail (product spec, #7046) — they belong to the gugu shell. Collapsed = a rail of the list's avatars:
// the same content, not moved, with its text hidden. Desktop only: the task renderer never runs in the phone shell.
export const LeftSidebar: React.FC = observer(function LeftSidebar() {
  const { navigate } = useNavigate();
  const { currentView } = useWorkspaceSlots();
  const { isLeftOpen, setLeftRail } = useWorkspaceLayoutContext();
  const notificationsOpen = useSidebarNotificationsOpen();
  const { translate } = useSessionMessages();

  // #5818 侧栏每一行 hover 要说「这一行是哪个 agent」:本机花名册整份读一次,之后靠 provisioned /
  // renamed 两条既有事件增量更新。要这张表的就是侧栏,所以由它点火;start() 幂等,收起再展开不重读。
  React.useEffect(() => {
    sessionAgentBindings.start();
  }, []);

  // #6264 别的机器上的项目与本机项目混排在「项目」分区里(按 Zed):侧栏挂上就开始跟那些机器的会话列表。
  // start() 幂等;桥晚到 / 登出被拆,store 自己跟着走。
  React.useEffect(() => {
    remoteHostsStore.start();
  }, []);

  const { value: interfaceSettings } = useAppSettingsKey('interface');

  // #5818 「悬浮时这一行变成它是谁」的开关,设置镜像进 store —— 读在设置里,用在每一行上。
  // #7199 个人助理不住在任务区:它是谁(壳按库里的标记认出来,经助理那座桥发过来),交给 store 去藏它自己的会话。
  const assistantShell = useAssistantShell();
  const assistantAgentId = assistantShell?.assistant?.id ?? null;
  const activeSessionId = appState.navigation.currentViewId === 'session' ? appState.navigation.viewParamsStore.session?.sessionId : undefined;
  const activeAgentId = activeSessionId ? sessionAgentBindings.bindingFor(activeSessionId)?.agentUserId : undefined;
  React.useEffect(() => {
    sidebarStore.setAssistantAgentId(assistantAgentId);
    // Identity may arrive after restoring an old task URL. Re-run the same route guard when it does.
    if (isAssistantAgent(activeAgentId, assistantAgentId)) appState.navigation.revalidate();
  }, [assistantAgentId, activeAgentId]);
  const agentNameOnHoverEnabled = interfaceSettings?.showLeftSidebarAgentNameOnHover ?? true;
  React.useEffect(() => {
    sidebarStore.setAgentNameOnHoverEnabled(agentNameOnHoverEnabled);
  }, [agentNameOnHoverEnabled]);
  // #2548 collapsing leaves the rail of avatars (the layout keeps that width), so the bell's panel cannot stay open in it;
  // the rail hides the bell (SidebarOneListHead).
  React.useEffect(() => setLeftRail(ONE_LIST_RAIL_PX), [setLeftRail]);
  const railed = !isLeftOpen;
  React.useEffect(() => {
    if (railed && notificationsOpen) setSidebarNotificationsOpen(false);
  }, [railed, notificationsOpen]);
  // What the rows look like follows the open/close progress, not the open state: the state flips the moment collapsing
  // starts (or only on release, for a drag), the progress is what is on screen.
  const railLayout = useLeftRailLayout();

  // 创建智能体 (what 新建任务 did) always lands on the dedicated compose view. Routing to 'project' instead made the
  // button a no-op whenever the user was already sitting on that project's home — which is the default landing view.
  const handleNewSession = () => {
    // behavior session-page「键盘导航」: it is the first station on the chain, so clicking it parks the cursor there.
    sessionKeyboardNav.syncCursorFromPointer({ kind: 'new-session' });
    navigate('new-session');
  };

  const { isDragOver, onDragOver, onDragEnter, onDragLeave, onDrop } = useSidebarDrop();

  // 壳画的对话列表要知道:正看着哪条对话(那一行高亮)。#2548 内层侧栏开着时是它那个群 / 项目:点进它里面的一个智能体,
  // 正文换成那条会话,那一行仍亮着(innerSidebarChat 是 mobx 的 box,这个 observer 读它就跟着变)。
  const viewedChatId =
    useNativeConversationChat(currentView === 'session'
      ? (appState.navigation.viewParamsStore.session as { sessionId?: string } | undefined)?.sessionId
      : currentView === 'screen' ? screenLayout.recentSession?.sessionId : undefined) ?? (currentView === 'chat'
      ? ((appState.navigation.viewParamsStore.chat as { chatId?: string } | undefined)?.chatId ?? null)
      : null);
  const innerChatId = innerSidebarChat.get()?.chatId ?? null;
  const focusedChatId = innerChatId ?? viewedChatId;
  // 拼在一屏的几组:壳画的「对话」也把同一组的几行并在一处(同「项目」这边)。
  const joinedGroups = sidebarStore.joinedGroups;
  // oneList: the desktop one list is mounted. The phone never mounts this sidebar, so the shell's shared components
  // (chat list, composer verbs, rail) read it to tell the desktop list from the phone.
  React.useEffect(
    () => publishSidebarChatView({ focusedChatId, groups: joinedGroups, oneList: true }),
    [focusedChatId, joinedGroups]
  );

  return (
    <div
      data-region="left-sidebar"
      className={cn(
        'relative flex h-full flex-col border-r border-border bg-background-tertiary text-foreground-tertiary-muted transition-colors',
        isDragOver && 'bg-background-2 ring-2 ring-inset ring-border-2',
        // #2548 a row's text (name, preview, time, its unread count) follows the open/close
        // progress (--gg-sidebar-text, workspace-layout: text only in the second half). On the rail the unread count sits on
        // the avatar's top-right corner instead (the muted bell stays out) and fades in near the end (--gg-sidebar-badge).
        // The count changes place at SIDEBAR_RAIL_LAYOUT_BELOW, where both are invisible, so nothing jumps. The rows narrow
        // with the sidebar, so the selected background ends the size of the avatar's cell.
        !railLayout && '[&_.gg-list-row-line>*]:opacity-(--gg-sidebar-text)',
        railLayout && [
          '[&_.gg-list-row-line>:not(.gg-list-row-trailing)]:opacity-(--gg-sidebar-text)',
          '[&_.gg-list-row-body]:pointer-events-none',
          '[&_.gg-list-row-trailing]:absolute [&_.gg-list-row-trailing]:top-1 [&_.gg-list-row-trailing]:left-7',
          '[&_.gg-list-row-trailing]:opacity-(--gg-sidebar-badge)',
          '[&_.gg-list-row-trailing>:not(.gg-chip)]:hidden',
        ]
      )}
      data-sidebar-rail={railLayout || undefined}
      onDragOver={onDragOver}
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {isDragOver && (
        <div className="pointer-events-none absolute inset-0 z-50 flex flex-col items-center justify-center gap-2 bg-background-tertiary/80 backdrop-blur-sm">
          <FolderInput className="size-8 text-foreground" />
          <span className="text-xs font-medium text-foreground">
            {translate('sidebar.dropToAddProject')}
          </span>
        </div>
      )}
      {/* The one-time bubble (C9) on the head comes up when the inner sidebar appears: a group, a project or the sample. */}
      <SidebarOneListHead innerShownFor={innerSidebarShownFor.get()} />
      <SidebarContainer className="min-h-0 w-full flex-1 border-r-0">
        <SidebarContent className="flex flex-col" data-notification-original-list="" style={notificationsOpen ? RETAINED_SURFACE_HIDDEN_STYLE : undefined}>
          <SidebarOneListTop collapsed={railed} onCreateAgent={handleNewSession} />
          {/* @@@sidebar-single-scroller — the list's one scroll container, with one content layer in it: the chat list
              (ChatListPanel, @@@sidebar-chat-window) virtualises its lines against these two. It must be a **block**: as a
              flex column the content layer is shrunk to the container's height, scrollHeight collapses with it and the
              scrollbar never shows again. */}
          <div
            data-region="sidebar-scroll"
            // #2548 rows scrolling down fade out over the last 24px above the window's bottom edge instead of being cut off.
            className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto mask-b-from-[calc(100%-1.5rem)]"
          >
            <div>
              <SidebarOneList />
              <SidebarOneListEmpty />
            </div>
          </div>
        </SidebarContent>
        <NotificationSlot part="list" active={notificationsOpen} />
        {/* #2548 已安排 lives in the bell's panel (mock v23 / v33). */}
        {notificationsOpen && (
          <SidebarMenu className="shrink-0 pb-2">
            <SidebarMenuButton
              isActive={isCurrentView(currentView, 'automations')}
              onClick={() => navigate('automations')}
              aria-label={translate('sidebar.scheduled')}
              className="w-full justify-between"
              data-testid="sidebar-scheduled"
            >
              <span className={cn('flex min-w-0 items-center gap-2', sidebarRowContentInsetX)}>
                <Clock className="h-5 w-5 shrink-0 sm:h-4 sm:w-4" />
                <span className="truncate">{translate('sidebar.scheduled')}</span>
              </span>
            </SidebarMenuButton>
          </SidebarMenu>
        )}
      </SidebarContainer>
    </div>
  );
});
