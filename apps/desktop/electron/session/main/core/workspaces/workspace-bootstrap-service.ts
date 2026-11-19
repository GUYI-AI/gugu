import { err, ok, type Result } from '@gugu/session-shared';
import type { CanonicalPath } from '@gugu/session-core/files';
import { stat } from 'node:fs/promises';
import { eq } from 'drizzle-orm';
import { rootFolderOf } from '@main/core/folders/folders';
import type { FolderRuntime, SessionMount } from '@main/core/workspaces/folder-runtime/folder-runtime';
import { folderRuntime } from '@main/core/workspaces/folder-runtime/folder-runtimes';
import { runtimeManager } from '@main/core/runtime/runtime-manager';
import {
  buildSessionFromWorkspace,
  emitSessionProvisionProgress,
  type MountedSession,
} from '@main/core/sessions/session-builder';
import { db as appDb, type AppDb } from '@main/db/client';
import { sessions, workspaces } from '@main/db/schema';
import type { ProvisionWorkspaceError } from '@shared/core/sessions/create-session';
import { log } from '@main/lib/logger';
import type { WorkspaceType } from '@shared/core/workspaces/workspaces';
import { isRetiredRemoteWorkspace, RETIRED_REMOTE_WORKSPACE_MESSAGE } from './resolve-workspace-kind';
import { createWorkspaceFactory } from './workspace-factory';
import { workspaceGitContext, type WorkspaceGitContext } from './workspace-git-context';
import { workspaceRegistry } from './workspace-registry';
import { taskName } from '@main/core/sessions/task-name';

export type WorkspaceBootstrapResult = {
  path: string;
  workspaceId: string;
  sessionMount: SessionMount;
};

/** The runtime of a workspace's root folder, opened on demand (null = the workspace is in no recorded folder). */
export type OpenRootFolder = (workspaceId: string) => Promise<FolderRuntime | null>;

async function openRootFolder(workspaceId: string): Promise<FolderRuntime | null> {
  const root = rootFolderOf(workspaceId);
  return root ? folderRuntime(root.id) : null;
}

export class WorkspaceBootstrapService {
  constructor(
    private readonly db: AppDb,
    private readonly openRoot: OpenRootFolder = openRootFolder
  ) {}

  /**
   * The registry is a cache. File/tree/git callers restore it without starting a session: a workspace mounts with
   * its root folder's runtime (a folder is its own root), never with an unrelated folder's settings or git.
   */
  async ensureWorkspaceSetupForWorkspace(workspaceId: string) {
    const cached = workspaceRegistry.get(workspaceId);
    if (cached) return cached;

    const workspaceRow = this.db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).get();
    if (!workspaceRow) return null;
    const session = this.db.select({ id: sessions.id, config: sessions.config })
      .from(sessions).where(eq(sessions.workspaceId, workspaceId)).limit(1).get();
    if (isRetiredRemoteWorkspace(workspaceRow)) throw new Error(RETIRED_REMOTE_WORKSPACE_MESSAGE);
    if (!workspaceRow.path) throw new Error(`Workspace ${workspaceId} has no directory`);
    // Mounting must never recreate a deleted real directory, including gitless workspaces.
    if (!(await stat(workspaceRow.path)).isDirectory()) throw new Error(`Workspace directory is not a folder: ${workspaceRow.path}`);
    const folder = await this.openRoot(workspaceId);
    if (!folder) return null;
    const acquired = await this._acquireWorkspace(
      workspaceId,
      session ? { id: session.id, title: taskName(session) } : { id: workspaceId, title: '' },
      folder,
      workspaceRow.path,
      workspaceGitContext(folder, { kind: workspaceRow.kind, path: workspaceRow.path }),
      false,
    );
    return acquired.workspace;
  }

  private _acquireWorkspace(
    workspaceId: string,
    session: MountedSession,
    folder: FolderRuntime,
    workDir: CanonicalPath,
    git: WorkspaceGitContext,
    retain = true
  ) {
    return workspaceRegistry.acquire(workspaceId, folder.folderId, createWorkspaceFactory(workspaceId, {
      session,
      workDir,
      folderId: folder.folderId,
      folderPath: folder.repoPath,
      workspaceRuntime: { manager: runtimeManager },
      settings: folder.settings,
      logPrefix: 'WorkspaceBootstrapService',
      ...git,
    }), { retain });
  }

  /**
   * Resolves where a session runs, acquires that workspace (running lifecycle
   * scripts), and builds the session's providers.
   *
   * A session always runs in a workspace that already exists — a folder or a directory inside one. No git setup is performed: the product does not create branches or worktrees for
   * a session, and a session that wants isolation creates its own from inside the session.
   */
  async ensureWorkspaceSetup(
    workspaceRow: {
      id: string;
      type: WorkspaceType;
      kind?: string | null;
      location?: 'local' | 'remote' | null;
      path: CanonicalPath | null;
    },
    session: MountedSession,
    folder: FolderRuntime
  ): Promise<Result<WorkspaceBootstrapResult, ProvisionWorkspaceError>> {
    if (isRetiredRemoteWorkspace(workspaceRow)) {
      return err({
        type: 'setup-failed',
        stepKind: 'byoi-config',
        stepErrorType: 'retired',
        message: RETIRED_REMOTE_WORKSPACE_MESSAGE,
      });
    }

    // Everything else runs in the directory its row names. A row without one says nowhere to run.
    if (!workspaceRow.path) return err({ type: 'no-intent' });
    return this._acquireAndBuild(
      workspaceRow.id,
      session,
      folder,
      workspaceRow.path,
      workspaceGitContext(folder, { kind: workspaceRow.kind, path: workspaceRow.path })
    );
  }

  /**
   * Public entry point for the RPC controller.
   * Loads the session + workspace rows from DB, opens the cwd's root folder,
   * and delegates to `ensureWorkspaceSetup`.
   */
  async ensureWorkspaceSetupForSession(
    sessionId: string
  ): Promise<Result<WorkspaceBootstrapResult, ProvisionWorkspaceError>> {
    const [row] = await this.db
      .select({
        id: sessions.id,
        config: sessions.config,
        workspaceId: sessions.workspaceId,
      })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .limit(1);
    if (!row?.workspaceId) return err({ type: 'missing-workspace' });

    const [wsRow] = await this.db
      .select()
      .from(workspaces)
      .where(eq(workspaces.id, row.workspaceId))
      .limit(1);
    if (!wsRow) return err({ type: 'missing-workspace' });

    // ⚠️ The folder may not be open yet: agents surviving a restart in tmux knock and cloud deliveries wake sessions
    // before any window asks for it (#6264: `not found` → MCP 401 → every gugu tool dead). Open it here, on demand.
    const folder = await this.openRoot(row.workspaceId);
    if (!folder) throw new Error(`Session ${row.id} runs in ${row.workspaceId}, which is in no folder on this device`);

    return this.ensureWorkspaceSetup(wsRow, { id: row.id, title: taskName(row) }, folder);
  }

  /**
   * Acquires the workspace via the registry (runs lifecycle scripts on first
   * acquire) then builds task providers. Returns a `WorkspaceBootstrapResult`.
   */
  private async _acquireAndBuild(
    workspaceId: string,
    session: MountedSession,
    folder: FolderRuntime,
    workDir: CanonicalPath,
    git: WorkspaceGitContext
  ): Promise<Result<WorkspaceBootstrapResult, ProvisionWorkspaceError>> {
    emitSessionProvisionProgress({
      sessionId: session.id,
      step: 'initialising-workspace',
      message: 'Initialising workspace…',
    });

    // #5331 转圈那一段的两大发就在这里:拿工作区(建 worktree + 首次 acquire 跑 lifecycle 脚本)
    // 与搭 provider(其中包含起会话)。用户从头到尾看到的是同一个转圈,而这两段从前一个读数都没有。
    const provisionStartedAt = Date.now();
    let acquired;
    try {
      acquired = await this._acquireWorkspace(workspaceId, session, folder, workDir, git);
    } catch (e) {
      return err({
        type: 'setup-failed',
        stepKind: 'workspace-acquire',
        stepErrorType: 'error',
        message: String(e),
      });
    }

    const acquireMs = Date.now() - provisionStartedAt;

    emitSessionProvisionProgress({
      sessionId: session.id,
      step: 'starting-sessions',
      message: 'Preparing task…',
    });

    const buildStartedAt = Date.now();
    let buildSucceeded = false;
    try {
      const buildResult = await buildSessionFromWorkspace(
        session,
        acquired.workspace,
        folder.folderId,
        folder.repoPath,
        folder.settings
      );
      buildSucceeded = true;
      log.info('WorkspaceBootstrapService:provision stages', {
        sessionId: session.id,
        folderId: folder.folderId,
        acquireMs,
        buildMs: Date.now() - buildStartedAt,
        totalMs: Date.now() - provisionStartedAt,
      });
      return ok({
        path: workDir,
        workspaceId,
        sessionMount: buildResult.sessionMount,
      });
    } catch (e) {
      return err({
        type: 'setup-failed',
        stepKind: 'build-providers',
        stepErrorType: 'error',
        message: String(e),
      });
    } finally {
      if (!buildSucceeded) {
        await workspaceRegistry.teardown(workspaceId, 'terminate').catch(() => {});
      }
    }
  }
}

export const workspaceBootstrapService = new WorkspaceBootstrapService(appDb);
