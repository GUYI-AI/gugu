import { useEffect } from 'react';
import { notify } from '@/lib/notices';
import { replicaAccount } from '@/lib/replica';
import { readInterface, writeInterface } from '@/lib/viewStateTable';
import { screenLayout } from '@renderer/app/screen-layout';
import { deepActiveElement } from '@renderer/features/sidebar/session-navigation-focus';
import { useShortcutOverrides } from '@renderer/lib/hooks/useKeyboardShortcuts';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
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

function cyclePane(step: number): boolean {
  const root = workspaceRoot();
  const focused = deepActiveElement();
  if (focused?.closest('[role="dialog"], [cmdk-root], [role="menu"]')) return false;
  const sidebar = root.querySelector<HTMLElement>('[data-region="left-sidebar"]');
  const block = activeBlock(root) ?? root.querySelector<HTMLElement>('[data-workspace-content-surface]');
  const firstVisible = (container: ParentNode | null, selector: string) =>
    Array.from(container?.querySelectorAll<HTMLElement>(selector) ?? []).find(el => el.checkVisibility());
  const editorSelector = '[data-testid="prompt-editor"], [data-testid="chat-composer"]';
  const editor = firstVisible(block, editorSelector) ?? firstVisible(root, editorSelector);
  const list = firstVisible(sidebar, '[data-nav-cursor], [role="option"][aria-selected="true"], [data-region="session-nav-focus"]')
    ?? firstVisible(sidebar, '[data-chat-row], [role="option"], button');
  const panes = [list, block, editor].filter((el): el is HTMLElement => !!el && el.checkVisibility());
  if (!panes.length) return false;
  const index = sidebar?.contains(focused) ? panes.indexOf(list!) : editor?.contains(focused)
    ? panes.indexOf(editor) : block?.contains(focused) ? panes.indexOf(block) : -1;
  const dest = panes[index < 0 ? (step > 0 ? 0 : panes.length - 1) : (index + step + panes.length) % panes.length];
  dest.focus();
  return deepActiveElement() === dest;
}

export function AppKeyboardShortcuts() {
  const showCommandPalette = useShowModal('commandPaletteModal');
  const keyboard = useShortcutOverrides();
  const account = replicaAccount().id;
  const { translate } = useSessionMessages();
  useEffect(() => {
    if (!account || !keyboard) return;
    if (readInterface<boolean>('keyboard-defaults-update', account)) return;
    writeInterface('keyboard-defaults-update', true, account);
    notify({ key: 'keyboard-defaults-update', tier: 'info', title: translate('keyboard.shortcutsUpdated'),
      action: { label: translate('keyboard.cheatSheetTitle'), onClick: () => { commandRegistry.dispatch('app.showKeyboardShortcuts'); } } });
  }, [account, keyboard, translate]);
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
    getCommands: () => [
      { id: 'app.focusNextPane', execute: () => cyclePane(1) },
      { id: 'app.focusPreviousPane', execute: () => cyclePane(-1) },
      { id: 'app.quickSwitcher', execute: () => openPalette('') },
      { id: 'app.commandPalette', execute: () => openPalette('> ') },
      // Mod+Shift+F reopens the last search; the other entry points set their query first (openGlobalSearch).
      { id: 'app.globalSearch', execute: () => showGlobalSearch({}) },
      { id: 'app.toggleLeftSidebar', execute: toggleLeft },
      { id: 'app.zenMode', execute: () => toggleZenMode() },
    ],
  });
  return null;
}
