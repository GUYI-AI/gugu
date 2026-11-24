import { observer } from 'mobx-react-lite';
import { useEffect, useRef, useState } from 'react';
import { AppWindow, Archive, Bell, Copy, Folder, GitFork, LayoutGrid, Pin, PanelLeft, RotateCcw, Search } from '@/lib/icons';
import { Avatar } from '@/components/Avatar';
import { ChatAppsPicker } from '@/components/chat/ChatAppsPicker';
import { DetailsChip, DetailsGroupTitle, DetailsSegmented, DetailsHero, DetailsList, DetailsName, DetailsPage, DetailsRow, DetailsSwitch, DetailsTile, DetailsTiles } from '@/components/details/DetailsParts';
import { DropdownMenu, MenuItem } from '@/components/ui/Menu';
import { InlineNameInput } from '@/components/ui/InlineNameInput';
import { Popover } from '@/components/ui/Popover';
import { useShownAgentName } from '@/hooks/useShownAgentName';
import { useAvatarIdentity } from '@/lib/avatarIdentity';
import { agentChatOf, setChatRowNotificationLevel, useChatSummaries } from '@/lib/chatSummariesBridge';
import { log } from '@renderer/utils/logger';
import { openInWindow } from '@renderer/app/screen-layout-actions';
import { WORKSPACE_APP_KIND } from '@renderer/features/chats/chat-tabs/chat-panel-item';
import { openGlobalSearch } from '@renderer/features/global-search/search-session';
import { rowPinOf } from '@renderer/features/sidebar/row-pin';
import { sidebarPinMenuAction } from '@renderer/features/sidebar/sidebar-pin';
import { setPinnedToSidebar } from '@renderer/features/sidebar/sidebar-pin-actions';
import { machineRegistry } from '@renderer/lib/machine-routing';
import { appState } from '@renderer/lib/stores/app-state';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import type { TabContentProps } from '../tabs/core/tab-provider';
import { LiveWindowDetailsCard } from '../live-window/LiveWindowDetailsCard';
import { openSessionInSessionWhenReady } from './open-session-in-session';
import type { SessionDetailsResource } from './session-details-tab';
import { useSessionViewContext, useWorkspaceViewModel } from './session-view-context';
import { sessionAgentBindings } from './stores/session-agent-bindings';
import { sessionRegistry } from './stores/session-registry';
import { useSessionTabCommands } from './view/session-actions';

export const TabContent = observer(function SessionDetailsTabContent({ host }: TabContentProps) {
  const tab = host.resolvedTabs.find((candidate) => candidate.kind === 'session-details' && candidate.isActive);
  const sessionId = tab ? (tab.resource as SessionDetailsResource).state.sessionId : null;
  return sessionId ? <SessionDetails key={sessionId} sessionId={sessionId} /> : null;
});

/**
 * 我的 agent 这条会话的「详情」(第 16 版设计稿,私聊详情那一页):头像 + 名字(点了直接改)+ 在哪台机器;
 * 它的电脑(用到才有,#43);搜索 / 文件 / 应用 / 单独成窗;置顶、固定到左侧栏、子会话 N ›(私聊不再带一级侧边栏,#45);
 * 会话那一组;最后是红色的归档。每一行的动作都是页签右键那张动作表里的同一个(session-menu.ts,经
 * useSessionTabCommands)—— 表里有的这里一个不少(#42),❌ 另抄一份。
 */
const SessionDetails = observer(function SessionDetails({ sessionId }: { sessionId: string }) {
  const { translate } = useSessionMessages();
  const { projectId } = useSessionViewContext();
  const view = useWorkspaceViewModel();
  const store = sessionRegistry.get(sessionId)?.sessions.get(sessionId);
  const [editing, setEditing] = useState(false);
  const commands = useSessionTabCommands(sessionId, () => setEditing(true));
  // 置顶 of a standalone agent is its chat-list row's (rowPinOf): re-read when the chat list changes.
  useChatSummaries();
  // 动作表里「旧私聊历史」这类开菜单时才去读有没有的项:详情页一打开就读一次。
  useEffect(() => { commands.forEach((command) => command.onMenuOpen?.()); }, [commands.length]);
  const name = useShownAgentName({ name: store?.data.title ?? '', agentType: store?.data.providerId, createdAt: store?.data.createdAt });
  const agentId = sessionAgentBindings.bindingFor(sessionId)?.agentUserId;
  const identity = useAvatarIdentity(agentId ?? '');
  const appsAnchor = useRef<HTMLButtonElement>(null);
  const [appsOpen, setAppsOpen] = useState(false);
  if (!store) return null;
  const command = (id: string) => commands.find((candidate) => candidate.id === `session:${id}` && (candidate.isAvailable?.() ?? true));
  const pin = rowPinOf(projectId, sessionId, {
    pinned: store.data.isPinned === true,
    setPinned: (pinned) => void sessionRegistry.get(sessionId)?.setSessionPinned(sessionId, pinned),
  });
  const sidebarPin = pin.row === 'chat' ? null : sidebarPinMenuAction({ parentSessionId: store.data.parentSessionId, isPinnedToSidebar: store.data.isPinnedToSidebar });
  const children = [...sessionRegistry.allSessions()].filter(([, child]) => child.data.parentSessionId === sessionId);
  const openChild = ([id, child]: (typeof children)[number]) => {
    const target = { projectId: child.data.projectId, sessionId: id };
    appState.navigation.navigate('session', target);
    openSessionInSessionWhenReady(target);
  };
  const local = !machineRegistry.machineOf(projectId);
  const chat = agentId ? agentChatOf(agentId) : null;
  const row = (id: string, icon: React.ReactNode, extra?: Partial<React.ComponentProps<typeof DetailsRow>>) => {
    const found = command(id);
    return found ? <DetailsRow key={id} icon={icon} label={found.label} testId={`session-details-session:${id}`}
      disabled={found.isEnabled ? !found.isEnabled() : false} onClick={() => void found.run()} {...extra} /> : null;
  };
  return (
    <DetailsPage testId="session-details">
      <DetailsHero
        avatar={<Avatar name={name} seed={agentId || sessionId} avatarUrl={identity?.avatar} isAgent size={64} still />}
        name={editing
          ? <InlineNameInput name={store.data.title ?? ''} onCommit={(next) => sessionRegistry.get(sessionId)!.renameSession(sessionId, next)} onClose={() => setEditing(false)} testId="session-details-name-input" />
          : <DetailsName name={name} onEdit={() => setEditing(true)} testId="session-details-name" />}
        sub={local ? <DetailsChip><span className="size-1.5 rounded-full bg-[var(--green)]" />{translate('task.deviceLocal')}</DetailsChip> : null}
      />
      <LiveWindowDetailsCard projectId={projectId} sessionId={sessionId} />
      <DetailsTiles>
        <DetailsTile icon={<Search />} label={translate('details.search')} testId="session-details-search"
          onClick={() => openGlobalSearch({ chips: [{ kind: 'in-task', taskId: sessionId, title: name }] })} />
        <DetailsTile icon={<Folder />} label={translate('workspace.files')} testId="session-details-files" onClick={() => view.paneLayout.openBeside(WORKSPACE_APP_KIND, {})} />
        <Popover.Root open={appsOpen} modal={false} onOpenChange={setAppsOpen}>
          <Popover.Trigger ref={appsAnchor} render={<DetailsTile icon={<LayoutGrid />} label={translate('details.apps')} testId="session-details-apps" />} />
          {appsOpen ? <ChatAppsPicker chatId={null} anchor={appsAnchor} onOpen={(app) => view.paneLayout.openBeside(app.kind, {})} onClose={() => setAppsOpen(false)} /> : null}
        </Popover.Root>
        <DetailsTile icon={<AppWindow />} label={translate('details.window')} testId="session-details-window" onClick={() => openInWindow({ kind: 'session', projectId, sessionId })} />
      </DetailsTiles>
      <DetailsList>
        {chat ? <DetailsRow icon={<Bell />} label={translate('details.notifications')} testId="session-details-notifications"
          end={<DetailsSegmented value={chat.summary.notificationLevel} onChange={(level) => void setChatRowNotificationLevel(chat.chatId, level)
            .catch((error: unknown) => log.error('[session-details] notification level failed', { error: error instanceof Error ? error.message : String(error) }))}
            options={(['all', 'important', 'none'] as const).map((level) => ({ value: level, label: translate(`details.notify.${level}`) }))} />} /> : null}
        {command('pin') ? <DetailsRow icon={<Pin />} label={translate('details.pin')} testId="session-details-pin"
          end={<DetailsSwitch on={pin.pinned} onChange={(on) => pin.setPinned(on)} label={translate('details.pin')} />} onClick={() => pin.setPinned(!pin.pinned)} /> : null}
        {sidebarPin && command('sidebar-pin') ? <DetailsRow icon={<PanelLeft />} label={translate('details.pinToSidebar')} testId="session-details-sidebar-pin"
          end={<DetailsSwitch on={sidebarPin === 'unpin'} onChange={(on) => setPinnedToSidebar(projectId, sessionId, on)} label={translate('details.pinToSidebar')} />}
          onClick={() => setPinnedToSidebar(projectId, sessionId, sidebarPin === 'pin')} /> : null}
        {children.length > 0 ? <DropdownMenu.Root modal={false}>
          <DropdownMenu.Trigger nativeButton={false} render={<div />}>
            <DetailsRow icon={<GitFork />} label={translate('details.children')} testId="session-details-children" end={children.length} chevron onClick={() => undefined} />
          </DropdownMenu.Trigger>
          <DropdownMenu.Content align="end" className="min-w-[240px]">
            {children.map((entry) => <MenuItem key={entry[0]} onClick={() => openChild(entry)}>{entry[1].data.title ?? entry[0]}</MenuItem>)}
          </DropdownMenu.Content>
        </DropdownMenu.Root> : null}
      </DetailsList>
      <DetailsGroupTitle>{translate('details.session')}</DetailsGroupTitle>
      <DetailsList>
        {row('reload', <RotateCcw />, { chevron: true })}
        {row('fork', <GitFork />)}
        {row('copy-id', <Copy />)}
        {row('legacy-history', <Archive />)}
      </DetailsList>
      {row('archive', <Archive />, { danger: true })}
    </DetailsPage>
  );
});
