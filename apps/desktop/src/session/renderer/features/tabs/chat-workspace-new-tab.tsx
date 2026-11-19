import { PanelRight, Plus } from '@/lib/icons';
import { observer } from 'mobx-react-lite';
import { Button } from '@renderer/lib/ui/button';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import type { PaneLayoutStore } from './pane-layout-store';

export function openChatWorkspaceNewTab(layout: PaneLayoutStore): string | undefined {
  return layout.open('browser', { workspaceStart: true }, { from: null, intent: 'newTab' });
}

export const ChatWorkspaceNewTab = observer(function ChatWorkspaceNewTab({ layout }: { layout: PaneLayoutStore }) {
  const { translate } = useSessionMessages();
  const initial = layout.chatToolLayout === 'empty';
  const name = translate(initial ? 'tabs.showToolTabs' : 'tabs.newWorkspaceTab');
  const Icon = initial ? PanelRight : Plus;
  return <Button size="icon-sm" variant="ghost" aria-label={name} title={name}
    data-testid="chat-new-workspace-tab" onClick={() => openChatWorkspaceNewTab(layout)}>
    <Icon className="size-3.5" />
  </Button>;
});
