import { workspaceSession } from '@shared/extensions/app-runtime-protocol';
import { observer } from 'mobx-react-lite';
import { useEffect, useState } from 'react';
import { workspaceReachLabel } from '@renderer/features/sessions/workspace-backend/workspace-surface';
import type { PeekTarget } from '@shared/extensions/app-runtime-protocol';
import { OpenWithSystemButton } from '@renderer/features/sessions/file-view/open-with-system-button';
import { rpc } from '@renderer/lib/ipc';
import { parseExtensionTabKind } from '@shared/extensions/manifest';
import { WorkspaceFileView } from '@renderer/features/sessions/file-view/workspace-file-view';
import { ExtensionTabPane } from './extension-tab-pane';
import { pickSessionOpener, type SessionOpener } from './open-with';

type FolderPeek = Extract<PeekTarget, { kind: 'folder' }>;

/**
 * G1 A file of a project's folder beside an App's page: the App that claims it, as a click in a session's files picks it
 * (`pickSessionOpener`) — else the preview a session's file tab draws. Nothing here is a second viewer. A folder on another
 * machine is the same: its project's calls go to that machine (machine-routing), and while it cannot be reached the
 * workspace's own line says why (offline since, sign in, update), as a session's files there say it.
 */
export const PeekFolderFile = observer(function PeekFolderFile({ target, tabId }: { target: FolderPeek; tabId: string }) {
  const unreachable = target.deviceId ? workspaceReachLabel(target.projectId) : null;
  return unreachable ? <Unread target={target} why={unreachable} /> : <Reachable target={target} tabId={tabId} />;
});

function Reachable({ target, tabId }: { target: FolderPeek; tabId: string }) {
  const held = useHeldWorkspace(target);
  const [opener, setOpener] = useState<SessionOpener | null>(null);
  useEffect(() => {
    let live = true;
    void pickSessionOpener(target.path, target.ask).then((picked) => live && setOpener(picked));
    return () => {
      live = false;
    };
  }, [target.path, target.ask]);
  if (!opener || held === null) return null;
  if (held !== 'ready') return <Unread target={target} why={held} />;
  if ('tabKind' in opener) {
    const extensionId = parseExtensionTabKind(opener.tabKind)?.extensionId ?? opener.tabKind;
    return (
      <ExtensionTabPane
        extensionId={extensionId}
        tabKind={opener.tabKind}
        sessionId={workspaceSession(target.place)}
        {...(workspaceSession(target.place) ? {} : { workspace: target.place.workspace })}
        tabId={tabId}
        filePath={target.path}
      />
    );
  }
  if ('cancelled' in opener) return <Unread target={target} />;
  return (
    <WorkspaceFileView
      projectId={target.projectId}
      workspaceId={target.workspaceId}
      {...(workspaceSession(target.place) ? { sessionId: workspaceSession(target.place)! } : {})}
      path={target.path}
      absolutePath={target.absolutePath}
      inWorkspace
      onClose={() => undefined}
    />
  );
}

/**
 * A project's folder is read through its workspace, held while the file is shown — as the new-task panel holds it with no
 * session there. A session's is held by its session. 'ready', why not, or null while asking.
 */
function useHeldWorkspace(target: FolderPeek): 'ready' | string | null {
  const project = workspaceSession(target.place) ? null : target.projectId;
  const { workspaceId } = target;
  const [held, setHeld] = useState<'ready' | string | null>(project ? null : 'ready');
  useEffect(() => {
    if (!project) return undefined;
    let disposed = false;
    let acquired = false;
    void (async () => {
      const opened = await rpc.projects.openProject(project);
      const result = opened.success ? await rpc.projects.acquireProjectWorkspace(project, workspaceId) : opened;
      if (!result.success) {
        if (!disposed) setHeld('message' in result.error ? result.error.message : result.error.type);
        return;
      }
      acquired = true;
      if (disposed) void rpc.projects.releaseProjectWorkspace(project, workspaceId);
      else setHeld('ready');
    })();
    return () => {
      disposed = true;
      if (acquired) void rpc.projects.releaseProjectWorkspace(project, workspaceId);
    };
  }, [project, workspaceId]);
  return held;
}

function Unread({ target, why }: { target: FolderPeek; why?: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center p-4 text-center text-sm text-foreground-muted">
      <p>{why ?? target.name}</p>
      {target.deviceId ? null : <OpenWithSystemButton absolutePath={target.absolutePath} workspace={target} />}
    </div>
  );
}
