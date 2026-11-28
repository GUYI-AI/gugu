import { useEffect } from 'react';
import { screenLayout } from '@renderer/app/screen-layout';
import { commandRegistry } from '@renderer/lib/commands/registry';
import { getPortalContainer } from '@renderer/lib/portal-container';
import { useCommandProvider } from '@renderer/lib/commands/use-command-provider';
import { useWorkspaceLayoutContext } from '@renderer/lib/layout/layout-provider';
import {
  useParams,
  useWorkspaceSlots,
} from '@renderer/lib/layout/navigation-provider';
import { useShowModal } from '@renderer/lib/modal/modal-provider';

function workspaceRoot(): ParentNode {
  return (getPortalContainer()?.getRootNode() ?? document) as ParentNode;
}

function activeBlock(root: ParentNode): HTMLElement | null {
  const id = screenLayout.focusedBlockId;
  const block = id ? root.querySelector<HTMLElement>(`[data-screen-block="${CSS.escape(id)}"]`) : null;
  return block?.checkVisibility() ? block : null;
}

export function AppKeyboardShortcuts() {
  const showCommandPalette = useShowModal('commandPaletteModal');
  const showGlobalSearch = useShowModal('globalSearchModal');
  const { exitZenMode, toggleLeft, toggleZenMode } = useWorkspaceLayoutContext();

  const { currentView } = useWorkspaceSlots();
  const { params: sessionParams } = useParams('session');
  const { params: projectParams } = useParams('project');

  const currentProjectId =
    currentView === 'session'
      ? sessionParams.projectId
      : currentView === 'project'
        ? projectParams.projectId
        : undefined;
  const currentSessionId = currentView === 'session' ? sessionParams.sessionId : undefined;

  useEffect(() => () => exitZenMode(), [currentProjectId, currentSessionId, currentView, exitZenMode]);

  const openPalette = (initialQuery: string) => showCommandPalette({
    initialQuery,
  });
  useCommandProvider({
    scopeId: 'app',
    getCommands: () => {
      const context = commandRegistry.contextElement?.closest<HTMLElement>('[data-screen-block]');
      const root = context?.checkVisibility() ? context : activeBlock(workspaceRoot());
      const buttons = Array.from((root ?? workspaceRoot()).querySelectorAll<HTMLButtonElement>(
        '[data-testid="composer-model-trigger"]:not(:disabled, [aria-disabled="true"])'
      )).filter(button => button.checkVisibility());
      const model = buttons.length === 1 ? buttons[0] : undefined;
      return [
        { id: 'session.switchModel', enabled: !!model, execute: () => { model?.click(); } },
        { id: 'app.quickSwitcher', execute: () => openPalette('') },
        { id: 'app.commandPalette', execute: () => openPalette('> ') },
        // Mod+Shift+F reopens the last search; the other entry points set their query first (openGlobalSearch).
        { id: 'app.globalSearch', execute: () => showGlobalSearch({}) },
        { id: 'app.toggleLeftSidebar', execute: toggleLeft },
        { id: 'app.zenMode', execute: () => toggleZenMode() },
      ];
    },
  });
  return null;
}
