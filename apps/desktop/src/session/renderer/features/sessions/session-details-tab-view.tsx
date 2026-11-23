import { observer } from 'mobx-react-lite';
import { useEffect, useState } from 'react';
import { ChevronRight, GitFork } from '@/lib/icons';
import { DropdownMenu, MenuItem } from '@/components/ui/Menu';
import { InlineNameInput } from '@/components/ui/InlineNameInput';
import { useShownAgentName } from '@/hooks/useShownAgentName';
import { appState } from '@renderer/lib/stores/app-state';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import type { TabContentProps } from '../tabs/core/tab-provider';
import { openSessionInSessionWhenReady } from './open-session-in-session';
import type { SessionDetailsResource } from './session-details-tab';
import { sessionRegistry } from './stores/session-registry';
import { useSessionTabCommands } from './view/session-actions';

export const TabContent = observer(function SessionDetailsTabContent({ host }: TabContentProps) {
  const tab = host.resolvedTabs.find((candidate) => candidate.kind === 'session-details' && candidate.isActive);
  return tab ? <SessionDetails key={(tab.resource as SessionDetailsResource).state.sessionId} sessionId={(tab.resource as SessionDetailsResource).state.sessionId} /> : null;
});

const rowClass = 'flex h-10 w-full cursor-pointer items-center gap-2.5 rounded-lg px-3 text-left text-[13.5px] hover:bg-row-hover disabled:cursor-default disabled:opacity-50';

/**
 * 我的 agent 这条会话的「详情」(第 16 版):名字(点了直接改)、子会话 N ›(私聊不再带一级侧边栏,子会话从这里进,
 * #45)、再是这条会话的全部动作 —— 读的就是页签右键那一张动作表(session-menu.ts,经 useSessionTabCommands),
 * 所以页签右键有的这里一个不少(#42),❌ 另抄一份。
 */
const SessionDetails = observer(function SessionDetails({ sessionId }: { sessionId: string }) {
  const { translate } = useSessionMessages();
  const store = sessionRegistry.get(sessionId)?.sessions.get(sessionId);
  const [editing, setEditing] = useState(false);
  const commands = useSessionTabCommands(sessionId, () => setEditing(true)).filter((command) => command.id !== 'session:rename' && (command.isAvailable?.() ?? true));
  const name = useShownAgentName({ name: store?.data.title ?? '', agentType: store?.data.providerId, createdAt: store?.data.createdAt });
  // 动作表里「旧私聊历史」这类开菜单时才去读有没有的项:详情页一打开就读一次。
  useEffect(() => { commands.forEach((command) => command.onMenuOpen?.()); }, [commands.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const children = [...sessionRegistry.allSessions()].filter(([, child]) => child.data.parentSessionId === sessionId);
  if (!store) return null;
  const open = ([id, child]: (typeof children)[number]) => {
    const target = { projectId: child.data.projectId, sessionId: id };
    appState.navigation.navigate('session', target);
    openSessionInSessionWhenReady(target);
  };
  return (
    <div data-testid="session-details" className="flex h-full min-h-0 flex-col overflow-y-auto px-4 py-5">
      <div className="flex flex-col items-center gap-1.5 pb-4">
        {editing
          ? <InlineNameInput name={store.data.title ?? ''} onCommit={(next) => sessionRegistry.get(sessionId)!.renameSession(sessionId, next)} onClose={() => setEditing(false)} testId="session-details-name-input" />
          : <button type="button" data-testid="session-details-name" onClick={() => setEditing(true)} className="max-w-full truncate rounded-md px-1 text-[19px] font-semibold hover:bg-row-hover">{name}</button>}
      </div>
      {children.length > 0 ? <DropdownMenu.Root modal={false}>
        <DropdownMenu.Trigger data-testid="session-details-children" render={<button type="button" className={rowClass} />}>
          <GitFork className="size-4 shrink-0" /><span className="flex-1">{translate('details.children')}</span>
          <span className="flex items-center gap-1 text-[12.5px] text-[var(--faint-fg)]">{children.length}<ChevronRight className="size-3.5" /></span>
        </DropdownMenu.Trigger>
        <DropdownMenu.Content align="end" style={{ minWidth: 240 }}>
          {children.map((entry) => <MenuItem key={entry[0]} onClick={() => open(entry)}>{entry[1].data.title ?? entry[0]}</MenuItem>)}
        </DropdownMenu.Content>
      </DropdownMenu.Root> : null}
      <div className="pt-3 pb-1 pl-3 text-[12px] text-[var(--muted-fg)]">{translate('details.session')}</div>
      {commands.map((command) => {
        const Icon = command.icon;
        return <button key={command.id} type="button" data-testid={`session-details-${command.id}`} className={rowClass}
          disabled={command.isEnabled ? !command.isEnabled() : false} onClick={() => void command.run()}>
          {Icon ? <Icon className="size-4 shrink-0" /> : <span className="size-4" />}<span className="flex-1 truncate">{command.label}</span>
        </button>;
      })}
    </div>
  );
});
