import type { IDisposable, IInitializable } from '@gugu/session-shared';
import { eq } from 'drizzle-orm';
import { githubRepositoryResolver } from '@main/core/github/services/github-repository-resolver';
import {
  resolveFolderGitHubAuthContext,
  type FolderGitHubAuthContextError,
} from '@main/core/github/services/folder-github-auth-context';
import { rootFolderOf } from '@main/core/folders/folders';
import { folderRuntimes } from '@main/core/workspaces/folder-runtime/folder-runtimes';
import { folderSettingsService } from '@main/core/workspaces/folder-runtime/settings/folder-settings-service';
import { sessionWorkspaceManager } from '@main/core/sessions/session-workspace-manager';
import { db } from '@main/db/client';
import { workspaceRemotes } from '@main/db/schema';
import { events } from '@main/lib/events';
import { log } from '@main/lib/logger';
import { prSyncProgressChannel } from '@shared/core/pull-requests/prEvents';
import { parseRepositoryRef } from '@shared/repository-ref';
import { prSyncEngine } from './pr-sync-engine';
import { syncFolderRemotes } from './folder-remotes-service';

const INCREMENTAL_SYNC_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Wires sync coordinator to application lifecycle events.
 * Called when a folder's runtime opens or closes, a session is provisioned, and repository remotes change.
 */
export class PrSyncScheduler implements IInitializable, IDisposable {
  /** Per-folder set of interval handles for light sync polling. */
  private readonly _intervals = new Map<string, ReturnType<typeof setInterval>[]>();
  /** Per-folder set of known GitHub remote URLs (for cleanup on unmount). */
  private readonly _folderRemoteUrls = new Map<string, string[]>();
  private readonly _repositoryUnsubscribes = new Map<string, () => void>();
  private _unsubscribes: Array<() => void> = [];

  initialize(): void {
    this._unsubscribes = [
      folderRuntimes.on('folderOpened', (id) => this.onFolderOpened(id)),
      folderRuntimes.on('folderClosed', (id) => this.onFolderClosed(id)),
      sessionWorkspaceManager.hooks.on('session:provisioned', ({ workspaceId, branchName }) => {
        const folder = rootFolderOf(workspaceId);
        if (folder) void this.onSessionProvisioned(folder.id, branchName);
      }),
      folderSettingsService.on('folder-settings:changed', ({ folderId }) => {
        void this.onFolderSettingsChanged(folderId);
      }),
    ];
  }

  dispose(): void {
    for (const unsub of this._unsubscribes) unsub();
    this._unsubscribes = [];
    const folderIds = new Set([
      ...this._intervals.keys(),
      ...this._folderRemoteUrls.keys(),
      ...this._repositoryUnsubscribes.keys(),
    ]);
    for (const folderId of folderIds) this.onFolderClosed(folderId);
  }

  async onFolderOpened(folderId: string): Promise<void> {
    log.info('PrSyncScheduler: onFolderOpened', { folderId });
    const remoteUrls = await this._syncAndGetGitHubRemotes(folderId);
    this._subscribeToRepository(folderId);

    if (remoteUrls.length === 0) {
      log.info('PrSyncScheduler: no GitHub remotes found, skipping sync', { folderId });
      return;
    }

    log.info('PrSyncScheduler: found GitHub remotes', { folderId, remoteUrls });
    this._folderRemoteUrls.set(folderId, remoteUrls);
    await this._startSyncIntervals(folderId, remoteUrls);
  }

  onFolderClosed(folderId: string): void {
    const handles = this._intervals.get(folderId) ?? [];
    log.info('PrSyncScheduler: onFolderClosed, clearing intervals and cancelling syncs', {
      folderId,
      intervals: handles.length,
    });
    for (const h of handles) clearInterval(h);
    this._intervals.delete(folderId);

    this._repositoryUnsubscribes.get(folderId)?.();
    this._repositoryUnsubscribes.delete(folderId);

    // Cancel in-flight syncs for all remotes of this folder
    const remoteUrls = this._folderRemoteUrls.get(folderId) ?? [];
    for (const url of remoteUrls) {
      prSyncEngine.cancel(url);
    }
    this._folderRemoteUrls.delete(folderId);
  }

  // ── Task lifecycle ─────────────────────────────────────────────────────────

  async onSessionProvisioned(folderId: string, sessionBranch: string | undefined): Promise<void> {
    if (!sessionBranch) return;

    const remoteUrls = await this._getGitHubRemoteUrls(folderId);
    for (const url of remoteUrls) {
      const prNumber = await this._findPrNumberForBranch(url, sessionBranch);
      if (prNumber !== null) {
        void this._syncSingle(folderId, url, prNumber);
      }
    }
  }

  // ── Remote model changes ───────────────────────────────────────────────────

  async onRemoteChanged(folderId: string): Promise<void> {
    const oldUrls = new Set(this._folderRemoteUrls.get(folderId) ?? []);

    // Re-sync workspace_remotes table and get new set
    const newUrls = await this._syncAndGetGitHubRemotes(folderId);
    const newSet = new Set(newUrls);

    // Cancel syncs for removed remotes
    for (const url of oldUrls) {
      if (!newSet.has(url)) {
        prSyncEngine.cancel(url);
      }
    }

    this._folderRemoteUrls.set(folderId, newUrls);
    await this._restartSyncIntervals(folderId, newUrls);
  }

  async onFolderSettingsChanged(folderId: string): Promise<void> {
    const remoteUrls =
      this._folderRemoteUrls.get(folderId) ?? (await this._getGitHubRemoteUrls(folderId));
    if (remoteUrls.length === 0) return;

    this._folderRemoteUrls.set(folderId, remoteUrls);
    this._cancelSyncs(remoteUrls);
    await this._syncRemotes(folderId, remoteUrls);
  }

  private async _restartSyncIntervals(folderId: string, remoteUrls: string[]): Promise<void> {
    this._clearIntervals(folderId);
    this._cancelSyncs(remoteUrls);
    await this._startSyncIntervals(folderId, remoteUrls);
  }

  private async _startSyncIntervals(folderId: string, remoteUrls: string[]): Promise<void> {
    this._clearIntervals(folderId);
    const intervals: ReturnType<typeof setInterval>[] = [];

    await this._syncRemotes(folderId, remoteUrls);

    for (const url of remoteUrls) {
      const handle = setInterval(() => {
        void this._syncRemote(folderId, url);
      }, INCREMENTAL_SYNC_INTERVAL_MS);

      intervals.push(handle);
    }

    this._intervals.set(folderId, intervals);
  }

  private _cancelSyncs(remoteUrls: string[]): void {
    for (const url of remoteUrls) {
      prSyncEngine.cancel(url);
    }
  }

  private _clearIntervals(folderId: string): void {
    const handles = this._intervals.get(folderId) ?? [];
    for (const h of handles) clearInterval(h);
    this._intervals.delete(folderId);
  }

  private _subscribeToRepository(folderId: string): void {
    if (this._repositoryUnsubscribes.has(folderId)) return;

    const folder = folderRuntimes.get(folderId);
    if (!folder) return;
    // gugu #2358: 非 git 文件夹无远端/PR —— 不订阅 remotes。
    if (!folder.gitRepository) return;

    const unsubscribe = folder.gitRepository.subscribeRemotes(() => {
      void this.onRemoteChanged(folderId).catch((error) => {
        log.warn('PrSyncScheduler: failed to handle remote model update', {
          folderId,
          error: String(error),
        });
      });
    });
    this._repositoryUnsubscribes.set(folderId, unsubscribe);
  }

  private async _resolveAuthContext(
    folderId: string,
    remoteUrl: string,
    kind: 'incremental' | 'single' = 'incremental'
  ) {
    const authContext = await resolveFolderGitHubAuthContext(folderId);
    if (authContext.success) return authContext.data;

    log.warn('PrSyncScheduler: failed to resolve folder GitHub account context', {
      folderId,
      error: authContext.error.message,
    });
    this._emitAuthResolutionError(remoteUrl, kind, authContext.error);
    return null;
  }

  private async _syncRemote(folderId: string, remoteUrl: string): Promise<void> {
    const authContext = await this._resolveAuthContext(folderId, remoteUrl);
    if (!authContext) return;
    // sync() routes to full or incremental based on cursor state.
    void prSyncEngine.sync(remoteUrl, authContext);
  }

  private async _syncRemotes(folderId: string, remoteUrls: string[]): Promise<void> {
    for (const url of remoteUrls) {
      await this._syncRemote(folderId, url);
    }
  }

  private async _syncSingle(folderId: string, remoteUrl: string, prNumber: number): Promise<void> {
    const authContext = await this._resolveAuthContext(folderId, remoteUrl, 'single');
    if (!authContext) return;
    void prSyncEngine.syncSingle(remoteUrl, prNumber, authContext);
  }

  private _emitAuthResolutionError(
    remoteUrl: string,
    kind: 'incremental' | 'single',
    error: FolderGitHubAuthContextError
  ): void {
    if (error.type !== 'unconfigured') return;
    events.emit(prSyncProgressChannel, {
      remoteUrl,
      kind,
      status: 'error',
      error: error.message,
    });
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private async _syncAndGetGitHubRemotes(folderId: string): Promise<string[]> {
    const folder = folderRuntimes.get(folderId);
    if (!folder) return [];
    // gugu #2358: 非 git 文件夹无远端。
    if (!folder.gitRepository) return [];

    try {
      const remotes = await folder.gitRepository.getRemotes();
      await syncFolderRemotes(folderId, remotes);
      const resolved = await Promise.all(
        remotes.map((r) => githubRepositoryResolver.resolve(r.url))
      );
      return resolved.flatMap((repository) =>
        repository.success ? [repository.data.repositoryUrl] : []
      );
    } catch (e) {
      log.warn('PrSyncScheduler: failed to sync folder remotes', { folderId, error: String(e) });
      return [];
    }
  }

  private async _getGitHubRemoteUrls(folderId: string): Promise<string[]> {
    const cached = this._folderRemoteUrls.get(folderId);
    if (cached) return cached;

    const rows = await db
      .select({ remoteUrl: workspaceRemotes.remoteUrl })
      .from(workspaceRemotes)
      .where(eq(workspaceRemotes.workspaceId, folderId));

    return rows.flatMap((r) => {
      const repository = parseRepositoryRef(r.remoteUrl);
      return repository ? [repository.repositoryUrl] : [];
    });
  }

  private async _findPrNumberForBranch(
    repositoryUrl: string,
    sessionBranch: string
  ): Promise<number | null> {
    const { pullRequests } = await import('@main/db/schema');
    const { and, eq: deq } = await import('drizzle-orm');
    const rows = await db
      .select({ identifier: pullRequests.identifier })
      .from(pullRequests)
      .where(
        and(
          deq(pullRequests.repositoryUrl, repositoryUrl),
          deq(pullRequests.headRefName, sessionBranch)
        )
      )
      .limit(1);

    if (!rows[0]?.identifier) return null;
    const n = Number.parseInt(rows[0].identifier.replace('#', ''), 10);
    return Number.isNaN(n) ? null : n;
  }
}

export const prSyncScheduler = new PrSyncScheduler();
