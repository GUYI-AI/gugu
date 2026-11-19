import type { BrowserKernelKind, BrowserKernelStatus } from '@shared/browser-kernel';
import type { StandaloneKernelAsset, StandaloneKernelInstallation, StandaloneKernelProgress } from './standalone-kernel-installer';

type Dependencies = {
  asset: StandaloneKernelAsset | null;
  selection(): Promise<BrowserKernelKind>;
  select(value: BrowserKernelKind): Promise<void>;
  installation(): Promise<StandaloneKernelInstallation | null>;
  install(input: { signal: AbortSignal; progress(value: StandaloneKernelProgress): void }): Promise<StandaloneKernelInstallation>;
  remove(): Promise<void>;
  inUse(): boolean;
};
type Operation = { cancellation: AbortController; previous: BrowserKernelKind; progress: StandaloneKernelProgress; done: Promise<void> };

/** User consent starts an installation; completion, cancellation and selection changes share one write order. */
export class StandaloneKernelManager {
  private active: Operation | null = null;
  private writes: Promise<unknown> = Promise.resolve();
  private error: string | null = null;

  constructor(private readonly dependencies: Dependencies) {}

  async status(): Promise<BrowserKernelStatus> {
    const [selected, installation] = await Promise.all([this.dependencies.selection(), this.dependencies.installation()]);
    const active = this.active;
    return {
      supported: this.dependencies.asset !== null,
      selected: active && !active.cancellation.signal.aborted ? 'standalone' : selected,
      phase: active ? active.cancellation.signal.aborted ? 'cancelling' : active.progress.stage : 'idle',
      asset: this.dependencies.asset ? { version: this.dependencies.asset.version, downloadBytes: this.dependencies.asset.bytes } : null,
      installation: installation ? { version: installation.version, installedBytes: installation.installedBytes } : null,
      receivedBytes: active?.progress.receivedBytes ?? 0,
      totalBytes: active?.progress.totalBytes ?? this.dependencies.asset?.bytes ?? 0,
      error: this.error,
    };
  }

  async useBuiltin(): Promise<void> {
    this.active?.cancellation.abort(new Error('Standalone browser download cancelled'));
    await this.write(() => this.dependencies.select('builtin'));
  }

  /** Called after explicit consent, or directly when the inspected version is already installed. */
  async downloadAndSwitch(): Promise<void> {
    await this.write(async () => {
      const asset = this.dependencies.asset;
      if (!asset) throw new Error('The standalone browser is not available on this platform');
      if (this.active) return;
      this.error = null;
      if (await this.dependencies.installation()) {
        await this.dependencies.select('standalone');
        return;
      }
      const operation: Operation = {
        cancellation: new AbortController(),
        previous: await this.dependencies.selection(),
        progress: { stage: 'downloading', receivedBytes: 0, totalBytes: asset.bytes },
        done: Promise.resolve(),
      };
      this.active = operation;
      operation.done = Promise.resolve().then(async () => {
        await this.dependencies.install({ signal: operation.cancellation.signal, progress: value => {
          if (this.active === operation && !operation.cancellation.signal.aborted) operation.progress = value;
        } });
        await this.write(async () => {
          if (this.active === operation && !operation.cancellation.signal.aborted) await this.dependencies.select('standalone');
        });
      }).catch(error => {
        if (!operation.cancellation.signal.aborted) this.error = error instanceof Error ? error.message : String(error);
      }).finally(() => { if (this.active === operation) this.active = null; });
    });
  }

  async cancel(): Promise<void> {
    const operation = this.active;
    operation?.cancellation.abort(new Error('Standalone browser download cancelled'));
    if (operation) await this.write(() => this.dependencies.select(operation.previous));
    await operation?.done;
  }

  async remove(): Promise<void> {
    await this.write(async () => {
      if (this.active || this.dependencies.inUse()) throw new Error('The standalone browser is still in use');
      // Preferences change before removal; profiles and existing built-in tabs are never removed here.
      await this.dependencies.select('builtin');
      await this.dependencies.remove();
      this.error = null;
    });
  }

  private write<T>(action: () => Promise<T>): Promise<T> {
    const next = this.writes.catch(() => undefined).then(action);
    this.writes = next;
    return next;
  }
}
