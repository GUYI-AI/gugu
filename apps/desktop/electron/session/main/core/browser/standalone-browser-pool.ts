import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import type { ServerTaskBrowser, TaskPageContents, TaskPageScreenTarget } from '../../../../server/server-task-browser';
import type { StandaloneKernelInstallation } from './standalone-kernel-installer';
import { isBrowserPartition } from './webview-security';

export type StandaloneHostCommand = (method: string, params?: Record<string, unknown>) => Promise<unknown>;
const PROFILE_TAB = 'profile-data:';
type Entry = { browser: ServerTaskBrowser; version: string; tabs: Set<string> };
type Binding = { partition: string; entry: Entry };
type Options = {
  profilesRoot: string;
  installation(): Promise<StandaloneKernelInstallation | null>;
  create(input: { profile: string; executable: string }): ServerTaskBrowser;
  /** Clock for the recent-sites memory; tests replace it. */
  now?(): number;
};
/** Chrome writes local storage to disk some seconds after the page stored it; a site shown this recently may not be listed there yet. */
const RECENT_SITE_MS = 60_000;

/** One persistent Chrome process per existing browser profile; tabs never combine unrelated profiles. */
export class StandaloneBrowserPool {
  private readonly profiles = new Map<string, Entry>();
  private readonly tabs = new Map<string, Binding>();
  private readonly partitionsByTab = new Map<string, string>();
  private readonly pending = new Map<string, Promise<unknown>>();
  private readonly recent = new Map<string, Map<string, number>>();
  private readonly watched = new WeakSet<object>();
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
  async pageFor(input: { browserId: string; partition: string; url?: string; popup?: string; signal: AbortSignal }): Promise<TaskPageContents> {
    if (!input.browserId.trim() || input.browserId.length > 256 || !isBrowserPartition(input.partition)) {
      throw new Error('Invalid standalone browser tab');
    }
    input.signal.throwIfAborted();
    const partition = this.partitionsByTab.get(input.browserId);
    if (partition && partition !== input.partition) throw new Error('The browser tab belongs to another profile');
    this.partitionsByTab.set(input.browserId, input.partition);
    return this.serial(input.partition, () => this.open(input));
  }

  /** Where a profile's Chrome keeps its data. Stable per partition, never shared between profiles. */
  directoryFor(partition: string): string {
    return path.join(this.options.profilesRoot, createHash('sha256').update(partition).digest('hex'));
  }

  /** Origins shown in the last minute in one profile, including tabs closed since. Memory only; nothing is written to disk. */
  recentOrigins(partition: string): string[] {
    const seen = this.recent.get(partition);
    if (!seen) return [];
    const now = (this.options.now ?? Date.now)();
    for (const [origin, at] of seen) if (now - at > RECENT_SITE_MS) seen.delete(origin);
    return [...seen.keys()];
  }

  private remember(partition: string, url: string | undefined): void {
    if (!url || !/^https?:\/\//i.test(url)) return;
    const seen = this.recent.get(partition) ?? new Map<string, number>();
    seen.set(new URL(url).origin, (this.options.now ?? Date.now)());
    this.recent.set(partition, seen);
  }

  /** Origins of the web pages open in one profile right now. */
  async openOrigins(partition: string): Promise<string[]> {
    const entry = this.profiles.get(partition);
    const origins = new Set<string>();
    for (const browserId of entry?.tabs ?? []) {
      const url = (await entry!.browser.existingPage(browserId))?.state().url;
      if (url && /^https?:\/\//i.test(url)) origins.add(new URL(url).origin);
    }
    return [...origins];
  }

  /** Partitions whose Chrome process is running now. */
  get livePartitions(): readonly string[] { return [...this.profiles.keys()]; }

  /**
   * Browser-level CDP on one profile for host work such as cookies. A throwaway tab starts the profile's Chrome when it
   * is not running and is closed with `close()`; tabs already open keep it alive either way.
   */
  async openProfileHost(partition: string): Promise<{ command: StandaloneHostCommand; close(): Promise<void> }> {
    if (!isBrowserPartition(partition)) throw new Error('Invalid standalone browser profile');
    const host = await this.serial(partition, () => this.openHost(partition));
    return { command: host.command, close: () => this.serial(partition, host.close) };
  }

  /**
   * Close every tab and the process of one profile so its directory can be rewritten: `clean` runs while the profile is
   * idle, then `restore` may seed what must survive. The tabs it had reopen at the addresses they were on.
   */
  async resetProfile(partition: string, steps: { clean(): Promise<void>; restore?(command: StandaloneHostCommand): Promise<void> }): Promise<void> {
    if (!isBrowserPartition(partition)) throw new Error('Invalid standalone browser profile');
    await this.serial(partition, async () => {
      const reopen: { browserId: string; url?: string }[] = [];
      const entry = this.profiles.get(partition);
      for (const browserId of entry ? [...entry.tabs] : []) {
        const binding = this.tabs.get(browserId);
        if (!binding) continue;
        const url = (await binding.entry.browser.existingPage(browserId))?.state().url;
        if (!browserId.startsWith(PROFILE_TAB)) reopen.push({ browserId, url: url && /^https?:\/\//i.test(url) ? url : undefined });
        await this.closeBound(browserId, binding);
        if (!browserId.startsWith(PROFILE_TAB)) this.partitionsByTab.set(browserId, partition); // Still registered, only its page is gone.
      }
      try {
        await steps.clean();
        if (steps.restore) {
          const host = await this.openHost(partition);
          try { await steps.restore(host.command); } finally { await host.close(); }
        }
      } finally {
        for (const tab of reopen) {
          await this.open({ browserId: tab.browserId, partition, url: tab.url, signal: AbortSignal.timeout(30_000) }).catch(() => {
            this.partitionsByTab.set(tab.browserId, partition);
          });
        }
      }
    });
  }

  private async openHost(partition: string): Promise<{ command: StandaloneHostCommand; close(): Promise<void> }> {
    const browserId = `${PROFILE_TAB}${randomUUID()}`;
    const close = async () => {
      const binding = this.tabs.get(browserId);
      if (binding) await this.closeBound(browserId, binding);
      this.partitionsByTab.delete(browserId);
    };
    try {
      const page = await this.open({ browserId, partition, signal: AbortSignal.timeout(30_000) });
      if (!page.hostCommand) throw new Error('The standalone browser host connection is unavailable');
      const host = page.hostCommand.bind(page);
      return { command: (method, params = {}) => host(method, params), close };
    } catch (error) {
      await close();
      throw error;
    }
  }

  private async open(input: { browserId: string; partition: string; url?: string; popup?: string; signal: AbortSignal }): Promise<TaskPageContents> {
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
        entry = { version: installation.version, tabs: new Set(), browser: this.options.create({
          executable: installation.executable, profile: this.directoryFor(input.partition),
        }) };
        this.profiles.set(input.partition, entry);
      }
      binding = { partition: input.partition, entry };
      entry.tabs.add(input.browserId);
      this.tabs.set(input.browserId, binding);
    }
    try {
      const page = await binding.entry.browser.pageFor(input.browserId, input.url, input.signal, input.popup);
      await this.watch(binding.partition, input.browserId, binding.entry.browser);
      return page;
    } catch (error) {
      await this.closeBound(input.browserId, binding);
      throw error;
    }
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

  /** Every address this page shows is a site that may have just stored something. */
  private async watch(partition: string, browserId: string, browser: ServerTaskBrowser): Promise<void> {
    const screen = await browser.existingPage(browserId).catch(() => null);
    if (!screen || this.watched.has(screen)) return;
    this.watched.add(screen);
    const note = () => this.remember(partition, screen.state().url);
    note();
    screen.on('state', note);
  }

  private async closeBound(browserId: string, binding: Binding): Promise<void> {
    if (this.tabs.get(browserId) !== binding) return;
    this.remember(binding.partition, (await binding.entry.browser.existingPage(browserId).catch(() => null))?.state().url);
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
