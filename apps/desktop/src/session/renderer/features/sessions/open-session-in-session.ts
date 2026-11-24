import { when } from 'mobx';
import { getSessionPageStore, getSessionView, sessionViewKind } from '@renderer/features/sessions/stores/session-selectors';
import { sessionTabKind } from './session-tab-kind';
import { sessionPaneReady } from './session-pane-ready';
import { drawnWithoutWorkspace, machineUnavailableLabel } from './machine-unavailable-label';
import { sessionRegistry } from './stores/session-registry';
import { toast } from '@renderer/lib/hooks/use-toast';
import { translateSessionMessage } from '@renderer/localization/locale-store';
import { rememberTask } from '@renderer/features/command-palette/recent-tasks';

interface OpenSessionInSessionOptions {
  projectId: string;
  sessionId: string;
  timeout?: number;
  /**
   * Commit navigation or layout only after the task workspace can be opened. Given = nothing is on screen until then, so a
   * timeout is told as a toast; without it the caller already showed the task and its page tells every state.
   */
  onReady?: () => void;
  /**
   * behavior session-page「键盘导航」: keyboard ↑↓ walks the sidebar and the main area follows every
   * step, so those opens must reuse the pane's preview slot instead of stacking a permanent tab per
   * station — otherwise arrowing past ten conversations leaves ten tabs behind. Click/notification
   * opens stay permanent (the default).
   */
  preview?: boolean;
  /**
   * 只在这条会话一枚页签都没有时开(给屏上一块空着的会话补上对话)。会话就绪时存下的页签已经摆回来了 = 不动,
   * ❌ 把人停在别的页签上的那一枚抢成对话。
   */
  onlyIfNoTabs?: boolean;
  /** 群聊点不同 Agent：把会话作为已有右栏里的新页签打开。 */
  host?: { projectId: string; sessionId: string };
}

/**
 * Opens a conversation only after the owning task has a live workspace.
 *
 * A registered task already owns a WorkspaceViewModel, so waiting for `getSessionView()` alone races
 * cold-start provisioning: the ACP tab mounts first, reads a null workspaceId, and gets stuck on
 * "No workspace found for task". The provisioned task is the actual readiness boundary.
 */
export function openSessionInSessionWhenReady({
  projectId,
  sessionId,
  timeout = 10_000,
  onlyIfNoTabs = false,
  host,
  onReady,
}: OpenSessionInSessionOptions): () => void {
  const kind = sessionViewKind(getSessionPageStore(projectId, sessionId), projectId);
  if (!onlyIfNoTabs && kind !== 'archived' && kind !== 'missing') rememberTask(sessionId);
  // A session whose machine does not answer opens now (SessionContentGate): its usual page and conversation without a
  // workspace when it is listed here. Preparing would only fail until that machine is back, when view.tsx prepares it.
  const withoutWorkspace = () => drawnWithoutWorkspace(getSessionPageStore(projectId, sessionId));
  if (!withoutWorkspace() && machineUnavailableLabel(projectId) && kind !== 'ready' && kind !== 'archived') {
    // Not listed here yet (its project mounts when that machine is back): the page says the machine is away.
    onReady?.();
    return () => {};
  }
  const paneReady = withoutWorkspace() ? () => false : sessionPaneReady(projectId, sessionId, { reviveArchived: false });
  return when(
    () => {
      const session = sessionRegistry
        .get(sessionId)
        ?.sessions.get(sessionId);
      return Boolean((paneReady() || withoutWorkspace()) && getSessionView(host?.projectId ?? projectId, host?.sessionId ?? sessionId) && session);
    },
    () => {
      const session = sessionRegistry
        .get(sessionId)
        ?.sessions.get(sessionId);
      if (!session) return;
      const paneLayout = getSessionView(host?.projectId ?? projectId, host?.sessionId ?? sessionId)?.paneLayout;
      if (!onlyIfNoTabs || !paneLayout?.groups.some((g) => g.pane.tabOrder.length > 0)) {
        const existing = paneLayout?.groups.flatMap((group) => [...group.pane.entries.values()]
          .filter((entry) => entry.kind === sessionTabKind(session.data.runtime) && (entry.state as { sessionId?: string } | null)?.sessionId === sessionId)
          .map((entry) => ({ group, entry })))[0];
        if (existing) {
          paneLayout!.setActiveGroup(existing.group.paneId);
          existing.group.pane.setActiveTab(existing.entry.tabId);
          onReady?.();
          return;
        }
        paneLayout?.open(
          sessionTabKind(session.data.runtime),
          { sessionId, ...(host ? { projectId, ownerSessionId: sessionId } : {}) },
          { from: null, intent: 'newTab' }
        );
      }
      onReady?.();
    },
    {
      timeout,
      onError: (error) => {
        console.error('[gugu] Timed out while opening a session-page session', {
          projectId,
          sessionId,
          error,
        });
        // Already on screen (no onReady): SessionContentGate says loading, offline or the failure in place (❌ a toast over
        // a page still saying it is loading). Placement held back until ready: nothing is on screen, this is the answer.
        if (!onReady) return;
        toast({
          title: translateSessionMessage('sidebar.conversationNotOpenable'),
          description: machineUnavailableLabel(projectId) ?? translateSessionMessage('sidebar.workspaceNotReady'),
          variant: 'destructive',
        });
      },
    }
  );
}
