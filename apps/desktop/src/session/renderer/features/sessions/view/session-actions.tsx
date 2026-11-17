import { observer } from 'mobx-react-lite';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { requestArchiveSession } from '@renderer/features/sessions/archive-session-flow';
import { copySessionId } from '@renderer/features/sessions/copy-session-id';
import { forkTask } from '@renderer/features/sessions/fork-task';
import { sidebarPinMenuAction } from '@renderer/features/sidebar/sidebar-pin';
import { setPinnedToSidebar } from '@renderer/features/sidebar/sidebar-pin-actions';
import { rowPinOf } from '@renderer/features/sidebar/row-pin';
import { useNavigate } from '@renderer/lib/layout/navigation-actions';
import { useAgents } from '@renderer/lib/stores/use-agents';
import { agentForksOn } from '@shared/core/agents/agent-payload';
import { sessionMenu, type SessionMenuAction } from '@/session/shared/session-menu';
import { menuTableIcon, menuTableLabel } from '@/components/menuTablePresentation';
import { useChatSummaries } from '@/lib/chatSummariesBridge';
import { requestSessionReload } from '@renderer/features/sessions/request-session-reload';
import { SessionReloadConfirm } from '@renderer/features/sessions/session-reload-confirm';
import { sessionRegistry } from '@renderer/features/sessions/stores/session-registry';
import type { TabCommand } from '@renderer/features/tabs/tab-bar/tab-commands';
import { findSessionHostBridge } from '@renderer/lib/electron-api';
import { rpc } from '@renderer/lib/ipc';
import { useShowModal } from '@renderer/lib/modal/modal-provider';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { log } from '@renderer/utils/logger';
import { useSessionViewContext } from '../session-view-context';
import { LegacyDmHistoryDialog } from '@/components/legacy-dm-history/LegacyDmHistoryEntry';
import { useLegacyDmHistoryEntry } from '@/components/legacy-dm-history/useLegacyDmHistoryEntry';

/**
 * 一条会话的动作在页签右键里的那一份 —— 动作表是 session/shared/session-menu.ts 那一张(与侧栏行、聊天列表里我的
 * agent 那一行、手机会话菜单同一张),这里只接上页签能跑的处理。
 *
 * 它们原来在聊天栏标题行的「⋯」里;会话的名字搬到它自己的页签上之后,这些动作跟着名字走:那枚页签的右键
 * (spec session-page:置顶 / 重命名 / 归档在这枚页签的右键里)。两种形态的会话页签(终端 / 聊天)读同一份,
 * 确认框也只有这里一份 —— 页签是一行一行画的,框画在页签里会跟着页签卸掉。
 *
 * spec session-graph「会话页菜单只动它点名的那条会话」:页签写的是谁,动的就是谁(子会话的页签动子会话)。
 */
interface SessionActions {
  commandsFor(sessionId: string, rename: () => void, legacyHistory: Pick<TabCommand, 'isAvailable' | 'onMenuOpen'>): TabCommand[];
}

const SessionActionsContext = createContext<SessionActions | null>(null);

/** The commands of the session a tab names, for its right-click menu. Outside a session page: none. */
export function useSessionTabCommands(sessionId: string | undefined, rename: () => void): TabCommand[] {
  const actions = useContext(SessionActionsContext);
  const legacyHistory = useLegacyDmHistoryEntry(sessionId);
  // 置顶 of a standalone agent is its chat-list row's (rowPinOf): the menu re-reads when the chat list changes.
  useChatSummaries();
  if (!actions || !sessionId) return [];
  return actions.commandsFor(sessionId, rename, legacyHistory);
}

export const SessionActionsProvider = observer(function SessionActionsProvider({ children }: { children: ReactNode }) {
  const { translate } = useSessionMessages();
  const { projectId, sessionId: pageSessionId } = useSessionViewContext();
  const showConfirm = useShowModal('confirmActionModal');
  const agentsReading = useAgents();
  const agents = agentsReading.state === 'value' ? agentsReading.value : null;
  const { navigate } = useNavigate();

  /**
   * 「重启本会话」按下确认之前攥着的那点东西 —— **两条腿都能重启**,所以认的是会话 id(宿主按它找记录)。
   * 宿主停完再起之后两条腿都原地接上:聊天面的副本跟着会话 id 走,终端认一个与进程无关的稳定 pty id。
   */
  const [pendingReload, setPendingReload] = useState<{ sessionId: string } | null>(null);
  const [reloading, setReloading] = useState(false);
  const [legacySessionId, setLegacySessionId] = useState<string | null>(null);

  const confirmReload = useCallback(async () => {
    const pending = pendingReload;
    if (!pending) return;
    setReloading(true);
    // Acceptance returns to the transcript; the action stays unavailable until the host finishes.
    setPendingReload(null);
    try {
      const result = await requestSessionReload({ sessionId: pending.sessionId, reason: 'manual' });
      if (!result.ok) {
        showConfirm({
          title: translate('task.manualReload'),
          description: result.error ?? '',
          confirmLabel: translate('common.close'),
          onSuccess: () => undefined,
        });
      }
    } finally {
      setReloading(false);
      setPendingReload(null);
    }
  }, [pendingReload, showConfirm, translate]);

  const actions = useMemo<SessionActions>(
    () => ({
      commandsFor(sessionId, rename, legacyHistory) {
        const session = sessionRegistry.get(pageSessionId)?.sessions.get(sessionId);
        if (!session) return [];
        const pin = rowPinOf(projectId, sessionId, {
          pinned: session.data.isPinned === true,
          setPinned: (pinned) => void sessionRegistry.get(sessionId)?.setSessionPinned(sessionId, pinned),
        });
        const sidebarPin = pin.row === 'chat' ? null : sidebarPinMenuAction({ parentSessionId: session.data.parentSessionId, isPinnedToSidebar: session.data.isPinnedToSidebar });
        const harness = agents?.find((agent) => agent.id === session.data.providerId);
        const run: Partial<Record<SessionMenuAction, () => void>> = {
          pin: () => pin.setPinned(!pin.pinned),
          'sidebar-pin': () => setPinnedToSidebar(projectId, sessionId, sidebarPin === 'pin'),
          rename,
          archive: () => requestArchiveSession({ projectId, sessionId }),
          fork: () => forkTask({ projectId, sessionId, navigate, translate }),
          'copy-id': () => void copySessionId(sessionId),
          reload: () => setPendingReload({ sessionId }),
          'legacy-history': () => setLegacySessionId(sessionId),
        };
        const items = sessionMenu('tab', {
          pinned: pin.pinned,
          sidebarPin,
          canFork: agentForksOn(harness?.capabilities, session.data.runtime ?? 'pty'),
          reloading,
          // Whether the legacy history exists is read when the menu opens (useLegacyDmHistoryEntry): offered, then hidden.
          hasLegacyHistory: true,
        }, new Set(Object.keys(run) as SessionMenuAction[]));
        return items.map((item): TabCommand => ({
          id: `session:${item.id}`,
          label: menuTableLabel(item.label),
          icon: menuTableIcon(item.icon),
          group: 'edit',
          ...(item.fold ? { fold: true as const } : {}),
          ...(item.id === 'rename' ? { shortcut: 'session.tabRename' as const } : {}),
          ...(item.id === 'legacy-history' ? legacyHistory : {}),
          ...(item.disabled ? { isEnabled: () => false } : {}),
          run: run[item.id]!,
        }));
      },
    }),
    [agents, navigate, pageSessionId, projectId, reloading, translate]
  );

  return (
    <SessionActionsContext.Provider value={actions}>
      {legacySessionId && <LegacyDmHistoryDialog sessionId={legacySessionId} onClose={() => setLegacySessionId(null)} />}
      <SessionReloadConfirm
        open={pendingReload !== null}
        onOpenChange={(next) => {
          if (!next && !reloading) setPendingReload(null);
        }}
        reason="manual"
        target={translate('task.manualReload')}
        isReloading={reloading}
        onConfirm={confirmReload}
      />
      {children}
    </SessionActionsContext.Provider>
  );
});

/**
 * 正看着的会话先过一道「就绪」:打开即确认它的平台凭据可用,开着的时候凭据过期也走同一道闸,
 * 再让下一次输入到达持着过期凭据的那一头。原来挂在聊天栏上(它那时只看一条),现在每一格正看着的会话各一份。
 */
export function SessionReadyGate({ sessionId }: { sessionId: string }) {
  useEffect(() => {
    void rpc.sessions.ensurePlatformSessionReady(sessionId, 'sessionpage-open').then((result) => {
      if (result.status === 'failed') log.error('[sessionpage-recovery] session open recovery failed', { sessionId, error: result.error });
    }).catch((error: unknown) => {
      log.error('[sessionpage-recovery] session open recovery failed', {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }, [sessionId]);
  useEffect(() => {
    const api = findSessionHostBridge();
    if (!api) return;
    return api.eventOn('session:platform-recovery-changed', (value) => {
      if (!value || typeof value !== 'object') return;
      const event = value as { sessionId?: unknown; status?: unknown };
      if (event.sessionId !== sessionId || event.status !== 'expired') return;
      void rpc.sessions.ensurePlatformSessionReady(sessionId, 'platform-expiry').then((result) => {
        if (result.status === 'failed') log.error('[sessionpage-recovery] active session expiry recovery failed', { sessionId, error: result.error });
      }).catch((error: unknown) => {
        log.error('[sessionpage-recovery] active session expiry recovery failed', {
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    });
  }, [sessionId]);
  return null;
}
