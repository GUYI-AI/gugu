import { createHash } from 'node:crypto';
import path from 'node:path';
import type { ServerTaskBrowser, TaskPageContents, TaskPageScreenTarget } from '../../../../server/server-task-browser';
import type { StandaloneKernelInstallation } from './standalone-kernel-installer';
import { isBrowserPartition } from './webview-security';

type Entry = { browser: ServerTaskBrowser; version: string; tabs: Set<string> };
type Binding = { partition: string; entry: Entry };
type Options = {
  profilesRoot: string;
  installation(): Promise<StandaloneKernelInstallation | null>;
  create(input: { profile: string; executable: string }): ServerTaskBrowser;
};

/** One persistent Chrome process per existing browser profile; tabs never combine unrelated profiles. */
export class StandaloneBrowserPool {
  private readonly profiles = new Map<string, Entry>();
  private readonly tabs = new Map<string, Binding>();
  private readonly partitionsByTab = new Map<string, string>();
  private readonly pending = new Map<string, Promise<unknown>>();
  private disposed = false;

  constructor(private readonly options: Options) {
    if (!path.isAbsolute(options.profilesRoot)) throw new Error('Standalone browser profiles need an absolute directory');
  }

  get inUse(): boolean { return this.profiles.size > 0 || this.tabs.size > 0 || this.partitionsByTab.size > 0 || this.pending.size > 0; }

  /** Registered hidden tabs still depend on this installation before their first page is opened. */
  reserveTab(browserId: string, partition: string): void {
    if (!browserId.trim() || !isBrowserPartition(partition)) throw new Error('Invalid standalone browser tab');
    if (this.disposed) throw new Error('The standalone browser pool is closed');
    const previous = this.partitionsByTab.get(browserId);
    if (previous && previous !== partition) throw new Error('The browser tab belongs to another profile');
    this.partitionsByTab.set(browserId, partition);
  }

  get versionsInUse(): ReadonlySet<string> {
    return new Set([...this.profiles.values()].map(entry => entry.version));
  }

  /** A new version takes effect after this profile's last tab and process have exited. */
  async pageFor(input: { browserId: string; partition: string; url?: string; signal: AbortSignal }): Promise<TaskPageContents> {
    if (!input.browserId.trim() || input.browserId.length > 256 || !isBrowserPartition(input.partition)) {
      throw new Error('Invalid standalone browser tab');
    }
    input.signal.throwIfAborted();
    const partition = this.partitionsByTab.get(input.browserId);
    if (partition && partition !== input.partition) throw new Error('The browser tab belongs to another profile');
    this.partitionsByTab.set(input.browserId, input.partition);
    return this.serial(input.partition, async () => {
      if (this.disposed) throw new Error('The standalone browser pool is closed');
      input.signal.throwIfAborted();
      this.partitionsByTab.set(input.browserId, input.partition);
      let binding = this.tabs.get(input.browserId);
      if (binding && binding.partition !== input.partition) throw new Error('The browser tab belongs to another profile');
      if (!binding) {
        let entry = this.profiles.get(input.partition);
        if (!entry) {
          const installation = await this.options.installation();
          input.signal.throwIfAborted();
          if (!installation) throw new Error('The standalone browser is not installed');
          const directory = createHash('sha256').update(input.partition).digest('hex');
          entry = { version: installation.version, tabs: new Set(), browser: this.options.create({
            executable: installation.executable, profile: path.join(this.options.profilesRoot, directory),
          }) };
          this.profiles.set(input.partition, entry);
        }
        binding = { partition: input.partition, entry };
        entry.tabs.add(input.browserId);
        this.tabs.set(input.browserId, binding);
      }
      try { return await binding.entry.browser.pageFor(input.browserId, input.url, input.signal); }
      catch (error) {
        await this.closeBound(input.browserId, binding);
        throw error;
      }
    });
  }

  async existingPage(browserId: string): Promise<TaskPageScreenTarget | null> {
    const binding = this.tabs.get(browserId);
    return binding ? binding.entry.browser.existingPage(browserId) : null;
  }

  async closeTab(browserId: string): Promise<void> {
    const partition = this.partitionsByTab.get(browserId);
    if (!partition) return;
    await this.serial(partition, async () => {
      const binding = this.tabs.get(browserId);
      if (binding) await this.closeBound(browserId, binding);
      this.partitionsByTab.delete(browserId);
    });
  }

  private async closeBound(browserId: string, binding: Binding): Promise<void> {
    if (this.tabs.get(browserId) !== binding) return;
    await binding.entry.browser.closeTask(browserId);
    this.tabs.delete(browserId);
    this.partitionsByTab.delete(browserId);
    binding.entry.tabs.delete(browserId);
    if (binding.entry.tabs.size === 0) {
      // Keep the profile reserved until the old process has really exited. Reopening waits in serial().
      await binding.entry.browser.dispose();
      if (this.profiles.get(binding.partition) === binding.entry) this.profiles.delete(binding.partition);
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await Promise.allSettled([...this.pending.values()]);
    const entries = [...this.profiles.values()];
    await Promise.all(entries.map(entry => entry.browser.dispose()));
    this.profiles.clear();
    this.tabs.clear();
    this.partitionsByTab.clear();
  }

  private serial<T>(partition: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.pending.get(partition) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(operation);
    this.pending.set(partition, next);
    void next.finally(() => { if (this.pending.get(partition) === next) this.pending.delete(partition); }).catch(() => undefined);
    return next;
  }
}
