import { FolderInput } from '@/lib/icons'
import { observer } from 'mobx-react-lite';
import React from 'react';
import { sessionAgentBindings } from '@renderer/features/sessions/stores/session-agent-bindings';
import { remoteHostsStore } from '@renderer/features/remote-hosts/remote-hosts-store';
import { useAssistantShell } from '@renderer/features/assistant/assistant-shell';
import { isAssistantAgent } from '@renderer/features/assistant/assistant-lineage';
import { useAppSettingsKey } from '@renderer/features/settings/use-app-settings-key';
import { sidebarRailTextOpacity, useLeftRailLayout, useSidebarProgressFollow, useWorkspaceLayoutContext } from '@renderer/lib/layout/layout-provider';
import { useNavigate, useWorkspaceSlots } from '@renderer/lib/layout/navigation-provider';
import { appState, sidebarStore } from '@renderer/lib/stores/app-state';
import { cn } from '@renderer/utils/utils';
import { SidebarContainer, SidebarContent } from './sidebar-primitives';
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
import { RailRowHint } from './rail-row-hint';
import { followBelowRailRow, followListOffset, SidebarOneListFoot, SidebarOneListHead, SidebarOneListTop } from './sidebar-one-list-chrome';
import { UnfinishedAgentCreates } from './unfinished-agent-creates';

// #2548 the desktop left sidebar, one list (界面减法: the zero rail, the window's leftmost column): the head (「«」), the
// search field, 创建智能体 + 「+」, then ONE list (SidebarOneList), then the foot (my avatar and its menu, 已安排, 会话历史,
// the bell) (sidebar-one-list-chrome). Collapsed = a rail of the list's avatars: the same content, not moved, with its text
// hidden. Desktop only: the task renderer never runs in the phone shell.
/**
 * #2548 where the names start in the list's scroll box: its inset (14 open, 8 on the rail: 界面减法 #48, the design's 12 + a
 * row's 8) + the row's padding 6 + the avatar 40 + the row gap 10. A row's unread count sits on its avatar's corner (left 30
 * in the row), before that.
 */
const NAMES_START_PX = 70;
const RAIL_NAMES_START_PX = 64;
/** The scroll box's own mask (its class: the last 24px above the window's bottom edge fade out), kept under the names'. */
const BOTTOM_FADE_MASK = 'linear-gradient(to bottom, black calc(100% - 1.5rem), transparent)';

/**
 * #2548 the rows' names fade with the open/close progress (sidebarRailTextOpacity) as one mask on the scroll box: the
 * avatars' column stays, everything right of it takes the names' opacity. One element's own style per frame, ❌ an opacity
 * on every name: that restyled the whole list each frame.
 */
function followNamesMask(scroll: HTMLElement, progress: number, railLayout: boolean) {
  const text = sidebarRailTextOpacity(progress);
  if (text >= 1) {
    scroll.style.removeProperty('mask-image');
    scroll.style.removeProperty('mask-composite');
    return;
  }
  const edge = railLayout ? RAIL_NAMES_START_PX : NAMES_START_PX;
  // The names' opacity in 255ths: the 8-bit alpha an rgb() literal painted, so the fade's pixels are unchanged.
  scroll.style.setProperty('mask-image', `linear-gradient(to right, black ${edge}px, color-mix(in srgb, black ${(Math.round(text * 255) / 2.55).toFixed(3)}%, transparent) ${edge}px), ${BOTTOM_FADE_MASK}`);
  scroll.style.setProperty('mask-composite', 'intersect');
}

/** The rail is the sidebar's attribute, written in the frame the edge lands with the layer's width, not by a re-render. */
function followRail(list: HTMLElement, _progress: number, railLayout: boolean) {
  list.toggleAttribute('data-sidebar-rail', railLayout);
}

/** The hint re-renders when the rail flips, on its own, not the whole sidebar with its rows. */
function RailHint({ list }: { list: React.RefObject<HTMLElement | null> }) {
  return <RailRowHint list={list} enabled={useLeftRailLayout()} />;
}

export const LeftSidebar: React.FC = observer(function LeftSidebar() {
  const { navigate } = useNavigate();
  // The page laid out, ❌ a modal over it (@@@page-modal): the market opened over a group keeps the group's row lit.
  const { pageView: currentView } = useWorkspaceSlots();
  const { isLeftOpen, toggleLeft } = useWorkspaceLayoutContext();
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

  const { settings: interfaceSettingsReading } = useAppSettingsKey('interface');
  const interfaceSettings = interfaceSettingsReading.state === 'value' ? interfaceSettingsReading.value.value : undefined;

  // #5818 「悬浮时这一行变成它是谁」的开关,设置镜像进 store —— 读在设置里,用在每一行上。
  // #7199 个人助理不住在任务区:它是谁(壳按库里的标记认出来,经助理那座桥发过来),交给 store 去藏它自己的会话。
  const assistantShell = useAssistantShell();
  const assistantAgentId = assistantShell?.assistant?.id ?? null;
  const activeSessionId = currentView === 'session' ? appState.navigation.viewParamsStore.session?.sessionId : undefined;
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
  // #2548 the rail of avatars has no room for the bell's list: collapsing closes it, and opening it from the bell in the
  // rail's foot expands the sidebar into it.
  const railed = !isLeftOpen;
  const wasRailed = React.useRef(railed);
  React.useEffect(() => {
    const collapsed = railed && !wasRailed.current;
    wasRailed.current = railed;
    if (!railed || !notificationsOpen) return;
    if (collapsed) setSidebarNotificationsOpen(false);
    else toggleLeft();
  }, [railed, notificationsOpen, toggleLeft]);
  // What the rows look like follows the open/close progress, not the open state: the state flips the moment collapsing
  // starts (or only on release, for a drag), the progress is what is on screen.
  const listRef = useSidebarProgressFollow<HTMLDivElement>(followRail);
  const scrollRef = useSidebarProgressFollow<HTMLDivElement>(followNamesMask);
  // The rows move with the fold, ❌ jump where the layout flips (followBelowRailRow, followListOffset).
  const belowRailRowRef = useSidebarProgressFollow<HTMLDivElement>(followBelowRailRow);
  const listOffsetRef = useSidebarProgressFollow<HTMLDivElement>(followListOffset);

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
  // 正看着的是一条对话自己(它在列表里有自己那一行,比如群旁边的一条私聊):亮它那一行。
  const innerChatId = innerSidebarChat.get()?.chatId ?? null;
  const focusedChatId = currentView === 'chat' ? viewedChatId : innerChatId ?? viewedChatId;
  // 拼在一屏的几组:壳画的「对话」也把同一组的几行并在一处(同「项目」这边)。
  const joinedGroups = sidebarStore.joinedGroups;
  // 并排着的几块:壳画的行(内层侧栏的话题)给「取消并排」认这一份(同会话页自己的行)。
  const splitKey = screenLayout.splitKeys.join('\n');
  // oneList: the desktop one list is mounted. The phone never mounts this sidebar, so the shell's shared components
  // (chat list, composer verbs, rail) read it to tell the desktop list from the phone.
  React.useEffect(
    () => publishSidebarChatView({ focusedChatId, groups: joinedGroups, split: splitKey ? splitKey.split('\n') : [], oneList: true }),
    [focusedChatId, joinedGroups, splitKey]
  );

  return (
    <div
      ref={listRef}
      data-region="left-sidebar"
      className={cn(
        // 界面减法 #10: the zero rail keeps the shell's warm translucent ground (no fill of its own); a line on its right
        // edge parts it from the content (#52).
        'relative flex h-full flex-col border-r border-border text-foreground-tertiary-muted transition-colors',
        isDragOver && 'bg-background-2 ring-2 ring-inset ring-border-2',
        // 界面减法 #53 #69: a row is a 52px square block on the rail (padding 6 around its 40px avatar), 52 tall open, 6 apart; its
        // unread mark sits on the avatar's top-right corner (AvatarUnread) and the row has no end (no time, no muted bell). Its
        // text (name, preview) follows the open/close progress through the scroll box's mask (followNamesMask).
        '[&_[data-region=sidebar-scroll]_.gg-list-row]:mb-[6px] [&_[data-region=sidebar-scroll]_.gg-list-row]:h-[52px] [&_[data-region=sidebar-scroll]_.gg-list-row]:!rounded-[12px] [&_[data-region=sidebar-scroll]_.gg-list-row]:!p-[6px] [&_[data-region=sidebar-scroll]_.gg-list-row-body]:!gap-0',
        // Design v16: the name is 14px regular, the preview line the caption size (the design's 12.5 is not on the type scale). `!`: the list row's own rules (.gg-list-row in
        // tokens.css) are outside the utilities layer, so a plain utility loses to them.
        '[&_[data-region=sidebar-scroll]_.gg-list-row-subtitle]:!text-[length:var(--font-caption)] [&_[data-region=sidebar-scroll]_.gg-list-row-title]:!font-normal',
        '[&_[data-region=sidebar-scroll]_.gg-chat-row-muted]:hidden',
        // The list's gutters: 14 open; on the rail 8 at the start and 4 at the end, where the 4px scrollbar (tokens.css
        // @@@scrollbar-autohide, it takes layout width) is always reserved: a list long enough to scroll otherwise narrowed every
        // 52px block by 4 while its 40px avatar kept its place, so the avatar sat off the block's centre (yangchichi 11-24).
        // Variables, ❌ padding classes on the box: the content layer spans the same gutters (@@@sidebar-blank-drags-window).
        'data-[sidebar-rail]:[&_[data-region=sidebar-scroll]]:[--sidebar-gutter:8px] data-[sidebar-rail]:[&_[data-region=sidebar-scroll]]:[--sidebar-gutter-end:4px] data-[sidebar-rail]:[&_[data-region=sidebar-scroll]]:[scrollbar-gutter:stable]'
      )}
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
      <RailHint list={listRef} />
      <SidebarOneListHead innerShownFor={innerSidebarShownFor.get()} />
      <SidebarContainer ref={belowRailRowRef} className="min-h-0 w-full flex-1 border-r-0">
        <SidebarContent className="flex flex-col" data-notification-original-list="" style={notificationsOpen ? RETAINED_SURFACE_HIDDEN_STYLE : undefined}>
          <SidebarOneListTop collapsed={railed} onCreateAgent={handleNewSession} />
          <UnfinishedAgentCreates collapsed={railed} />
          {/* @@@sidebar-single-scroller — the list's one scroll container, with one content layer in it: the chat list
              (ChatListPanel, @@@sidebar-chat-window) virtualises its lines against these two. It must be a **block**: as a
              flex column the content layer is shrunk to the container's height, scrollHeight collapses with it and the
              scrollbar never shows again. */}
          <div
            ref={scrollRef}
            data-region="sidebar-scroll"
            // #2548 rows scrolling down fade out over the last 24px above the window's bottom edge instead of being cut off.
            // @@@sidebar-blank-drags-window - the list's blank space below its rows drags the window, as the head band above
            // does (yangchichi 11-24): the scroll box is a drag region and its one content layer opts out, gutters included,
            // so every row keeps its clicks, its HTML5 drag and the wheel. app-region is inherited, so the opt-out is on the
            // layer itself, ❌ on each row.
            className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto pl-(--sidebar-gutter) pr-(--sidebar-gutter-end) [--sidebar-gutter:14px] [--sidebar-gutter-end:var(--sidebar-gutter)] mask-b-from-[calc(100%-1.5rem)] [-webkit-app-region:drag]"
          >
            <div ref={listOffsetRef} className="-ml-(--sidebar-gutter) -mr-(--sidebar-gutter-end) pl-(--sidebar-gutter) pr-(--sidebar-gutter-end) [-webkit-app-region:no-drag]">
              <SidebarOneList />
              <SidebarOneListEmpty />
            </div>
          </div>
        </SidebarContent>
        <NotificationSlot part="list" active={notificationsOpen} />
      </SidebarContainer>
      <SidebarOneListFoot />
    </div>
  );
});
