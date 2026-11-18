import { Plus } from '@/lib/icons';
import { Button } from '@renderer/lib/ui/button';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import type { PaneLayoutStore } from './pane-layout-store';

export function openChatWorkspaceNewTab(layout: PaneLayoutStore): string | undefined {
  return layout.open('browser', { workspaceStart: true }, { from: null, intent: 'newTab' });
}

export function ChatWorkspaceNewTab({ layout }: { layout: PaneLayoutStore }) {
  const { translate } = useSessionMessages();
  const name = translate('tabs.newWorkspaceTab');
  return <Button size="icon-sm" variant="ghost" aria-label={name} title={name}
    data-testid="chat-new-workspace-tab" onClick={() => openChatWorkspaceNewTab(layout)}>
    <Plus className="size-3.5" />
  </Button>;
}
