import { sep } from 'node:path';
import { err, ok, type Result } from '@gugu/session-shared';
import { ResourceMap } from '../lib';
import type { IWatchService } from '../services/fs-watch/api';
import { nativeWatchBackend } from '../services/fs-watch/impl/native-backend';
import { realpathOrResolve } from '../services/fs-watch/impl/paths';
import { createWatchService } from '../services/fs-watch/impl/watch-service';
import { FileChanges } from './changes/changes';
import type { FileError, FilesOnError } from './errors';
import { FileSystem } from './fs/file-system';
import { validateAbsolutePath } from './paths';
import type { FileTreeError, FileTreeOnError } from './tree/errors';
import { FileTree } from './tree/file-tree';
import type { FileTreeLease } from './tree/types';
import type {
  FileChangeSubscription,
  FileChangeUpdate,
  FileChangeWatchOptions,
  IFileSystem,
  IFilesRuntime,
} from './types';

export type FilesRuntimeOptions = {
  watcher?: IWatchService;
  onError?: FilesOnError & FileTreeOnError;
};

export class FilesRuntime implements IFilesRuntime {
  private readonly trees: ResourceMap<FileTree>;
  private readonly fs = new FileSystem();
  private readonly watcher: IWatchService;
  private readonly ownsWatcher: boolean;
  private disposeRequested = false;

  constructor(private readonly options: FilesRuntimeOptions = {}) {
    this.ownsWatcher = !options.watcher;
    this.watcher =
      options.watcher ??
      createWatchService({
        backend: nativeWatchBackend({ onError: options.onError }),
        onError: options.onError,
      });
    this.trees = new ResourceMap<FileTree>({
      teardown: (_key, tree) => tree.dispose(),
      onError: options.onError,
      onEmpty: () => {
        void this.disposeIfIdle();
      },
    });
  }

  async openTree(rootPath: string): Promise<Result<FileTreeLease, FileTreeError>> {
    if (this.disposeRequested) {
      return err({
        type: 'fs-error',
        path: '',
        message: 'FilesRuntime disposed',
      });
    }
    const validatedRoot = validateAbsolutePath(rootPath);
    if (!validatedRoot.success) return validatedRoot;
    const resolvedRoot = realpathOrResolve(validatedRoot.data);
    const lease = await this.trees.acquire(resolvedRoot, async () => {
      return new FileTree({
        rootPath: resolvedRoot,
        watcher: this.watcher,
        onError: this.options.onError,
      });
    });
    try {
      const ready = await lease.value.ready();
      if (!ready.success) {
        await lease.release();
        return err(ready.error);
      }
      return ok(lease);
    } catch (error) {
      await lease.release();
      throw error;
    }
  }

  watchChanges(
    rootPath: string,
    cb: (update: FileChangeUpdate) => void,
    options?: FileChangeWatchOptions
  ): Result<FileChangeSubscription, FileError> {
    if (this.disposeRequested) {
      return err({
        type: 'fs-error',
        path: '',
        message: 'FilesRuntime disposed',
      });
    }
    const validatedRoot = validateAbsolutePath(rootPath);
    if (!validatedRoot.success) return validatedRoot;
    const named = validatedRoot.data;
    const real = realpathOrResolve(named);
    const changes = new FileChanges({ rootPath: real, watcher: this.watcher });
    // @@@named-root - the watch runs on the real folder, but what changed is said under the root as the caller named it:
    // every consumer compares with that name (a workspace's recorded path, a server's task folder through the account link
    // `accounts/<id>` → `account`), so real paths matched none of them.
    const underNamed = (path: string) =>
      path === real ? named : path.startsWith(real + sep) ? named + path.slice(real.length) : path;
    const report = real === named ? cb : (update: FileChangeUpdate) =>
      cb(update.kind === 'resync' ? update : { kind: 'changes', changes: update.changes.map((change) => ({ ...change, path: underNamed(change.path) })) });
    const subscription = changes.watch(report, options);
    if (!subscription.success) {
      changes.dispose();
      return subscription;
    }
    return ok({
      ready: subscription.data.ready,
      unsubscribe: () => {
        subscription.data.unsubscribe();
        changes.dispose();
      },
    });
  }

  watchDirectory(dirPath: string): Result<() => void, FileError> {
    if (this.disposeRequested) {
      return err({ type: 'fs-error', path: dirPath, message: 'FilesRuntime disposed' });
    }
    const validated = validateAbsolutePath(dirPath);
    if (!validated.success) return validated;
    const handle = this.watcher.watch(validated.data, () => {}, { recursive: false });
    // 目录已经不在(文件随目录一起被删):单层订阅起不来,撤掉即可 —— 文件的「已删除」由它所在的
    // 整棵树订阅里上一级目录的事件报出来。
    void handle.ready().catch((error: unknown) => {
      this.options.onError?.(`watch directory ${dirPath}`, error);
      void handle.release();
    });
    return ok(() => void handle.release());
  }

  nudge(rootPath?: string): Promise<boolean> {
    return this.watcher.nudge(rootPath);
  }

  fileSystem(): Result<IFileSystem, FileError> {
    if (this.disposeRequested) {
      return err({
        type: 'fs-error',
        path: '',
        message: 'FilesRuntime disposed',
      });
    }
    return ok(this.fs);
  }

  async dispose(): Promise<void> {
    this.disposeRequested = true;
    await this.trees.dispose();
    await this.disposeIfIdle();
  }

  private async disposeIfIdle(): Promise<void> {
    if (!this.disposeRequested || !this.trees.idle || !this.ownsWatcher) return;
    await this.watcher.dispose();
  }
}
