import { when } from 'mobx';
import { messageForUser } from '@/lib/userFacingError';
import { openSessionInSessionWhenReady } from '@renderer/features/sessions/open-session-in-session';
import { sessionRegistry } from '@renderer/features/sessions/stores/session-registry';
import { asProvisioned, getSessionManagerStore, getSessionPageStore } from '@renderer/features/sessions/stores/session-selectors';
import { toast } from '@renderer/lib/hooks/use-toast';

/**
 * Fork a task and open the fork in its own task. The sidebar row and the timeline's message menu both start it here.
 * The fork reuses the source task's workspace, which exists only once the source is provisioned: navigate first, fork
 * when ready.
 */
export function forkTask({ projectId, sessionId, navigate, translate }: {
  projectId: string;
  sessionId: string;
  navigate: (view: 'session', params: { projectId: string; sessionId: string }) => void;
  translate: (key: 'sidebar.forkFailed' | 'sidebar.forked' | 'sidebar.workspaceNotReady') => string;
}): void {
  const failed = (error: unknown) => {
    toast({ title: translate('sidebar.forkFailed'), description: messageForUser(error), variant: 'destructive' });
  };
  navigate('session', { projectId, sessionId });
  when(
    () => Boolean(asProvisioned(getSessionPageStore(projectId, sessionId)) && sessionRegistry.get(sessionId)),
    () => {
      void sessionRegistry
        .get(sessionId)
        ?.forkSession(sessionId)
        .then((created) => {
          // #6269 分叉住在自己的新任务里 —— 去那项任务打开,❌ 在来源任务里开。
          // The call can return before session:created reaches the task list, and the session view's guard sends a
          // task the list does not know back to the empty page. Go there once the list has it.
          when(
            () => Boolean(getSessionManagerStore(projectId)?.sessions.get(created.id)),
            () => {
              navigate('session', { projectId, sessionId: created.id });
              openSessionInSessionWhenReady({ projectId, sessionId: created.id });
              toast({ title: translate('sidebar.forked') });
            },
            { timeout: 15_000, onError: failed },
          );
        })
        .catch(failed);
    },
    {
      timeout: 15_000,
      onError: () => {
        toast({ title: translate('sidebar.forkFailed'), description: translate('sidebar.workspaceNotReady'), variant: 'destructive' });
      },
    }
  );
}
