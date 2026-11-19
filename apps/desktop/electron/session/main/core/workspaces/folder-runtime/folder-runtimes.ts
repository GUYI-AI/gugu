import { LifecycleMap } from '@gugu/session-shared';
import { err, ok, type IDisposable, type IReleasable, type Result } from '@gugu/session-shared';
import { HookCore, type Hookable } from '@main/lib/hookable';
import { log } from '@main/lib/logger';
import type { OpenProjectError as OpenFolderError } from '@shared/projects';
import { getFolder, type Folder } from '@main/core/folders/folders';
import { sessionBootTasks } from '@main/core/boot-tasks';
import { TimeoutSignal, withTimeout } from '@main/core/utils/timeout';
import { checkIsValidDirectory } from '@main/core/utils/directory-status';
import { createFolderRuntime } from './create-folder-runtime';
import type { FolderRuntime } from './folder-runtime';
import { PATH_ACCESS_PROBE_TIMEOUT_MS, probePathAccess } from './probe-path-access';

const LOCAL_PROVIDER_TIMEOUT_MS = 20_000;
const TEARDOWN_PROVIDER_TIMEOUT_MS = 60_000;

type FolderRuntimesHooks = {
  folderOpened: (folderId: string, runtime: FolderRuntime) => void | Promise<void>;
  folderClosed: (folderId: string) => void | Promise<void>;
};

type ProviderLifecycleError =
  | { type: 'timeout'; message: string; timeout: number }
  | { type: 'error'; message: string };

function toInitError(e: unknown): ProviderLifecycleError {
  if (e instanceof TimeoutSignal) return { type: 'timeout', message: e.message, timeout: e.ms };
  return { type: 'error', message: e instanceof Error ? e.message : String(e) };
}

function toTeardownError(e: unknown): ProviderLifecycleError {
  if (e instanceof TimeoutSignal) return { type: 'timeout', message: e.message, timeout: e.ms };
  return { type: 'error', message: e instanceof Error ? e.message : String(e) };
}

class FolderRuntimes
  implements Hookable<FolderRuntimesHooks>, IReleasable, IDisposable
{
  private readonly _hooks = new HookCore<FolderRuntimesHooks>((name, e) =>
    log.error(`FolderRuntimes: ${String(name)} hook error`, e)
  );
  private readonly _lifecycle = new LifecycleMap<
    FolderRuntime,
    ProviderLifecycleError,
    ProviderLifecycleError
  >({
    postProvision: (id, provider) => this._hooks.callHookBackground('folderOpened', id, provider),
    postTeardown: (id) => this._hooks.callHookBackground('folderClosed', id),
  });

  on<K extends keyof FolderRuntimesHooks>(name: K, handler: FolderRuntimesHooks[K]) {
    return this._hooks.on(name, handler);
  }

  async open(folder: Folder): Promise<Result<FolderRuntime, ProviderLifecycleError>> {
    return this._lifecycle.provision(folder.id, async () => {
      try {
        const provider = await withTimeout(createFolderRuntime(folder), LOCAL_PROVIDER_TIMEOUT_MS);
        if (!provider.success) return err({ type: 'error', message: provider.error.message });
        return ok(provider.data);
      } catch (e) {
        const initError = toInitError(e);
        log.error('FolderRuntimes: error opening folder', {
          folderId: folder.id,
          ...initError,
        });
        return err(initError);
      }
    });
  }

  async close(folderId: string): Promise<Result<void, ProviderLifecycleError>> {
    return (
      this._lifecycle.teardown(folderId, async (provider) => {
        try {
          await withTimeout(provider.dispose(), TEARDOWN_PROVIDER_TIMEOUT_MS);
          return ok();
        } catch (e) {
          const error = toTeardownError(e);
          log.error('FolderRuntimes: error closing folder', { folderId, ...error });
          return err(error);
        }
      }) ?? ok()
    );
  }

  /** The folder's runtime when it is open (openFolder opens it). */
  get(folderId: string): FolderRuntime | undefined {
    return this._lifecycle.get(folderId);
  }

  async dispose(): Promise<void> {
    const ids = Array.from(this._lifecycle.keys());
    await Promise.allSettled(ids.map((id) => this.close(id)));
    for (const id of ids) {
      const status = this._lifecycle.teardownStatus(id);
      if (status.status === 'error') {
        log.error('FolderRuntimes: folder close error recorded after dispose', {
          folderId: id,
          message: status.error.message,
        });
      }
    }
  }

  async release(): Promise<void> {
    const providers = Array.from(this._lifecycle.values());
    const results = await Promise.allSettled(providers.map((provider) => provider.release()));
    const failures = results.filter((result) => result.status === 'rejected');
    for (const failure of failures) {
      log.error('FolderRuntimes: failed to release', failure.reason);
    }
    if (failures.length > 0) throw failures[0].reason;
  }
}

export const folderRuntimes = new FolderRuntimes();

/**
 * Open a folder's runtime on demand (an open one is returned as is). The directory is probed first: when reading it
 * hangs (macOS TCC prompt not yet answered, #3611) the person has to grant access, which a timeout would not say.
 */
export async function openFolder(folderId: string): Promise<Result<FolderRuntime, OpenFolderError>> {
  const open = folderRuntimes.get(folderId);
  if (open) return ok(open);
  const folder = getFolder(folderId);
  if (!folder) return err({ type: 'error', message: `Folder not found: ${folderId}` });
  if (!checkIsValidDirectory(folder.path)) return err({ type: 'path-not-found', path: folder.path });
  const probe = await probePathAccess(folder.path);
  // Only macOS TCC hangs waiting for a grant; elsewhere a slow probe means a busy process, left to the open budget.
  if (probe.kind === 'blocked' && process.platform === 'darwin') {
    log.warn('openFolder: folder path unreadable within probe budget', {
      folderId, path: folder.path, timeoutMs: PATH_ACCESS_PROBE_TIMEOUT_MS,
    });
    return err({ type: 'path-access-blocked', path: folder.path });
  }
  if (probe.kind === 'failed') return err({ type: 'error', message: probe.message });
  const result = await folderRuntimes.open(folder);
  if (!result.success) return err({ type: 'error', message: result.error.message });
  // A failure recorded at startup is cleared by any later successful open (on demand too) — only here.
  sessionBootTasks.clear('project-open', folderId);
  return ok(result.data);
}

/** The folder's runtime, opened on demand; throws when it cannot be opened (for callers that must have it). */
export async function folderRuntime(folderId: string): Promise<FolderRuntime> {
  const opened = await openFolder(folderId);
  if (opened.success) return opened.data;
  const error = opened.error;
  throw new Error(`Folder ${folderId} could not be opened: ${error.type === 'error' ? error.message : `${error.type} ${error.path}`}`);
}
