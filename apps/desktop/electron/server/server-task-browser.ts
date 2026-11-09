import { type ChildProcess } from 'node:child_process';
import { spawn, execFile } from '@gugu/core/local/childProcess';
import { EventEmitter } from 'node:events';
import { onErrorEvents } from '@gugu/session-shared';
import { mkdir } from 'node:fs/promises';
import type { Readable, Writable } from 'node:stream';
import { promisify } from 'node:util';

/**
 * #1607 node 4b — a Gugu server's task pages (owner decision 11-08): one headless Chromium ("new" headless) per
 * account, started by gugu-server on the first lease and owned by it. A task gets one page, kept across leases so its
 * sign-ins and state stay; the account's profile directory keeps logins across restarts. No virtual display, never
 * another process's display, no third-party browser service. The user agent does not announce HeadlessChrome.
 *
 * The browser speaks CDP over `--remote-debugging-pipe` (no port). Each page is handed to the shared
 * `createPageProtocol` as a WebContents-shaped object (`TaskPageContents`): the same restricted page protocol,
 * maintenance rules and lease teardown as a desktop tab — this file only supplies the page.
 */

type CdpMessage = { id?: number; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { message: string }; sessionId?: string };

/** The subset of Electron's `WebContents` / `Debugger` that `createPageProtocol` uses. */
export interface TaskPageContents {
  readonly debugger: {
    attach(protocolVersion?: string): void;
    detach(): void;
    isAttached(): boolean;
    sendCommand(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<unknown>;
    on(event: 'message' | 'detach', listener: (...args: never[]) => void): unknown;
    removeListener(event: 'message' | 'detach', listener: (...args: never[]) => void): unknown;
  };
  isDestroyed(): boolean;
  once(event: 'destroyed', listener: () => void): unknown;
  /** 'destroyed', and the navigation events the shared guard watches. */
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  removeListener(event: string, listener: (...args: unknown[]) => void): unknown;
  getTitle(): string;
  getURL(): string;
  isLoading(): boolean;
  readonly navigationHistory: { getAllEntries(): { url: string }[]; getActiveIndex(): number; removeEntryAtIndex(index: number): boolean };
}

/** A pipe-connected Chromium: commands, events and one exit. */
class PipeConnection extends EventEmitter {
  private next = 0;
  private readonly pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  private buffer = '';
  closed: Error | null = null;

  constructor(private readonly write: Writable, read: Readable) {
    super();
    read.setEncoding('utf8');
    read.on('data', (chunk: string) => {
      this.buffer += chunk;
      let end: number;
      while ((end = this.buffer.indexOf('\0')) >= 0) {
        const text = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + 1);
        this.receive(JSON.parse(text) as CdpMessage);
      }
    });
    read.on('close', () => this.fail(new Error('the task browser exited')));
  }

  private receive(message: CdpMessage) {
    if (message.id !== undefined) {
      const waiter = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) waiter?.reject(new Error(message.error.message));
      else waiter?.resolve(message.result);
      return;
    }
    this.emit('event', message);
  }

  send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<unknown> {
    if (this.closed) return Promise.reject(this.closed);
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.write.write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0');
    });
  }

  fail(error: Error) {
    if (this.closed) return;
    this.closed = error;
    for (const waiter of this.pending.values()) waiter.reject(error);
    this.pending.clear();
    this.emit('closed', error);
  }
}

/** One task's page as a WebContents-shaped object; each `attach` is one flattened CDP session on its target. */
class PageTarget extends EventEmitter implements TaskPageContents {
  private session: string | null = null;
  private readonly children = new Set<string>();
  private readonly native = new EventEmitter();
  private destroyed = false;
  /** The host's own session: navigation and loading state for the shared navigation guard, never lent. */
  private watchSession: string | null = null;
  private mainFrame: string | null = null;
  private loading = false;
  private history: { entries: { url: string }[]; index: number } = { entries: [], index: -1 };
  title = '';
  url = 'about:blank';

  constructor(private readonly connection: PipeConnection, readonly targetId: string) {
    super();
    connection.on('event', this.onEvent);
  }

  private readonly onEvent = (message: CdpMessage) => {
    if (message.method === 'Target.targetDestroyed' && message.params?.targetId === this.targetId) return this.destroy();
    if (message.method === 'Target.targetInfoChanged') {
      const info = message.params?.targetInfo as { targetId?: string; title?: string; url?: string } | undefined;
      if (info?.targetId === this.targetId) { this.title = info.title ?? this.title; this.url = info.url ?? this.url; }
      return;
    }
    if (message.method === 'Target.detachedFromTarget' && message.params?.sessionId === this.session) {
      this.session = null;
      this.children.clear();
      this.native.emit('detach', {}, 'target closed');
      return;
    }
    if (this.watchSession && message.sessionId === this.watchSession) return this.onWatch(message);
    if (!this.session || !message.sessionId) return;
    if (message.sessionId !== this.session && !this.children.has(message.sessionId)) return;
    if (message.method === 'Target.attachedToTarget') this.children.add(String(message.params?.sessionId));
    if (message.method === 'Target.detachedFromTarget') this.children.delete(String(message.params?.sessionId));
    // Electron's debugger reports the page's own events without a session id.
    this.native.emit('message', {}, message.method, message.params ?? {}, message.sessionId === this.session ? '' : message.sessionId);
  };

  readonly debugger = {
    attach: (): void => {
      if (this.destroyed) throw new Error('the task page was closed');
      if (this.session) throw new Error('Another debugger is already attached to this task page');
      // Electron attaches synchronously; reserve the slot and resolve the session before the first command.
      this.session = 'attaching';
      this.attaching = this.connection.send('Target.attachToTarget', { targetId: this.targetId, flatten: true }).then((result) => {
        this.session = (result as { sessionId: string }).sessionId;
      }, (error: Error) => { this.session = null; throw error; });
      void this.attaching.catch(() => {});
    },
    detach: (): void => {
      const session = this.session;
      this.session = null;
      this.children.clear();
      if (session && session !== 'attaching') void this.connection.send('Target.detachFromTarget', { sessionId: session }).catch(() => {});
    },
    isAttached: (): boolean => this.session !== null,
    sendCommand: async (method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<unknown> => {
      await this.attaching;
      if (!this.session || this.session === 'attaching') throw new Error('the task page debugger is not attached');
      if (sessionId && !this.children.has(sessionId)) throw new Error('unknown session');
      return this.connection.send(method, params, sessionId || this.session);
    },
    on: (event: 'message' | 'detach', listener: (...args: never[]) => void) => this.native.on(event, listener as (...args: unknown[]) => void),
    removeListener: (event: 'message' | 'detach', listener: (...args: never[]) => void) => this.native.removeListener(event, listener as (...args: unknown[]) => void),
  };
  private attaching: Promise<void> = Promise.resolve();

  /**
   * Electron's navigation events, from the host's watch session — what page-navigation-access.ts uses to revoke a
   * lease before a local document can be read: did-start-navigation / did-navigate / did-stop-loading.
   */
  private onWatch(message: CdpMessage) {
    const params = message.params ?? {};
    const main = (frameId: unknown) => frameId === this.mainFrame;
    switch (message.method) {
      case 'Page.frameStartedNavigating':
        if (main(params.frameId)) this.emit('did-start-navigation', { isMainFrame: true, url: String(params.url) });
        break;
      case 'Page.frameStartedLoading':
        if (main(params.frameId)) this.loading = true;
        break;
      case 'Page.frameStoppedLoading':
        if (main(params.frameId)) { this.loading = false; this.emit('did-stop-loading', {}); }
        break;
      case 'Page.frameNavigated': {
        const frame = params.frame as { id?: string; parentId?: string; url?: string; urlFragment?: string } | undefined;
        if (!frame || frame.parentId || !main(frame.id)) break;
        this.url = `${frame.url ?? ''}${frame.urlFragment ?? ''}`;
        this.emit('did-navigate', {}, this.url);
        void this.readHistory();
        break;
      }
      case 'Page.navigatedWithinDocument':
        if (main(params.frameId)) { this.url = String(params.url); void this.readHistory(); }
        break;
    }
  }

  /** Watch from creation, before any lease can miss a navigation. */
  async watch(): Promise<void> {
    const { sessionId } = await this.connection.send('Target.attachToTarget', { targetId: this.targetId, flatten: true }) as { sessionId: string };
    this.watchSession = sessionId;
    await this.connection.send('Page.enable', {}, sessionId);
    const tree = await this.connection.send('Page.getFrameTree', {}, sessionId) as { frameTree: { frame: { id: string; url: string } } };
    this.mainFrame = tree.frameTree.frame.id;
    await this.readHistory();
  }

  private async readHistory() {
    if (!this.watchSession || this.destroyed) return;
    const read = await this.connection.send('Page.getNavigationHistory', {}, this.watchSession).catch(() => null) as
      { currentIndex: number; entries: { url: string }[] } | null;
    if (!read) return;
    // A page that has not committed yet reports '' — the same empty document Electron calls about:blank.
    this.history = { entries: read.entries.map(({ url }) => ({ url: url || 'about:blank' })), index: read.currentIndex };
  }

  readonly navigationHistory = {
    getAllEntries: () => this.history.entries,
    getActiveIndex: () => this.history.index,
    // CDP cannot remove one entry. Refusing makes the shared guard revoke the lease instead (fail closed).
    removeEntryAtIndex: () => false,
  };

  isLoading() { return this.loading; }
  isDestroyed() { return this.destroyed; }
  getTitle() { return this.title; }
  getURL() { return this.url; }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.connection.off('event', this.onEvent);
    this.emit('destroyed');
  }
}

/** Chrome's own user agent, minus the headless marker (reduced UA form: major.0.0.0). */
export function taskBrowserUserAgent(versionOutput: string, platform: NodeJS.Platform = process.platform): string {
  const major = /(\d+)\.\d+\.\d+\.\d+/.exec(versionOutput)?.[1];
  if (!major) throw new Error(`Cannot read the task browser version from "${versionOutput.trim()}"`);
  const os = platform === 'darwin' ? 'Macintosh; Intel Mac OS X 10_15_7' : platform === 'win32' ? 'Windows NT 10.0; Win64; x64' : 'X11; Linux x86_64';
  return `Mozilla/5.0 (${os}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

export function taskBrowserArguments(profile: string, userAgent: string, root: boolean): string[] {
  return [
    '--headless=new', '--remote-debugging-pipe', `--user-data-dir=${profile}`, `--user-agent=${userAgent}`,
    '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-sync',
    '--password-store=basic', '--use-mock-keychain',
    ...(root ? ['--no-sandbox'] : []),
    'about:blank',
  ];
}

export interface ServerTaskBrowser {
  /** This task's page (opened at `url` the first time), as the shared page protocol's contents. */
  pageFor(sessionId: string, url: string | undefined, signal: AbortSignal): Promise<TaskPageContents>;
  /** The task ended: close its page. */
  closeTask(sessionId: string): Promise<void>;
  dispose(): Promise<void>;
}

export function createServerTaskBrowser(options: {
  binary: () => string | null;
  profile: string;
  log: { info(message: string, fields?: object): void; warn(message: string, fields?: object): void };
}): ServerTaskBrowser {
  let starting: Promise<{ process: ChildProcess; connection: PipeConnection }> | null = null;
  const pages = new Map<string, Promise<PageTarget>>();

  async function launch() {
    const binary = options.binary();
    if (!binary) throw new Error('Browser Use on this server needs Chrome or Chromium (GUGU_APP_BROWSER_CHROME selects it)');
    const { stdout } = await promisify(execFile)(binary, ['--version'], { timeout: 15_000 });
    const userAgent = taskBrowserUserAgent(stdout);
    await mkdir(options.profile, { recursive: true });
    const child = spawn(binary, taskBrowserArguments(options.profile, userAgent, process.getuid?.() === 0), {
      stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-2000); });
    const connection = new PipeConnection(child.stdio[3] as Writable, child.stdio[4] as Readable);
    // A failed spawn or a broken pipe ends this browser, never the host process.
    onErrorEvents([child, child.stderr, child.stdio[3] as Writable, child.stdio[4] as Readable], (error) => {
      connection.fail(new Error(`the task browser failed: ${error.message}`));
      options.log.warn('Task browser failed', { error: error.message });
    });
    child.once('exit', (code, signal) => {
      connection.fail(new Error(`the task browser exited (${signal ?? code})`));
      options.log.warn('Task browser exited', { code, signal, stderr: stderr.trim().slice(-500) });
    });
    connection.once('closed', () => {
      if (starting) starting = null;
      for (const page of pages.values()) void page.then((target) => target.destroy(), () => {});
      pages.clear();
    });
    await connection.send('Target.setDiscoverTargets', { discover: true });
    options.log.info('Task browser started', { pid: child.pid, userAgent });
    return { process: child, connection };
  }

  function browser() {
    starting ??= launch().catch((error: unknown) => { starting = null; throw error; });
    return starting;
  }

  async function open(sessionId: string, url: string | undefined): Promise<PageTarget> {
    const { connection } = await browser();
    const { targetId } = await connection.send('Target.createTarget', { url: url ?? 'about:blank' }) as { targetId: string };
    const target = new PageTarget(connection, targetId);
    target.url = url ?? 'about:blank';
    await target.watch();
    target.once('destroyed', () => {
      void pages.get(sessionId)?.then((current) => { if (current === target) pages.delete(sessionId); }, () => {});
    });
    return target;
  }

  return {
    async pageFor(sessionId, url, signal) {
      signal.throwIfAborted();
      let page = pages.get(sessionId);
      if (!page) {
        page = open(sessionId, url);
        pages.set(sessionId, page);
        void page.catch(() => { if (pages.get(sessionId) === page) pages.delete(sessionId); });
      }
      const target = await page;
      signal.throwIfAborted();
      if (target.isDestroyed()) {
        pages.delete(sessionId);
        return this.pageFor(sessionId, url, signal);
      }
      return target;
    },
    async closeTask(sessionId) {
      const page = pages.get(sessionId);
      pages.delete(sessionId);
      const target = await page?.catch(() => null);
      if (!target || target.isDestroyed()) return;
      const running = await starting?.catch(() => null);
      await running?.connection.send('Target.closeTarget', { targetId: target.targetId }).catch(() => {});
      target.destroy();
    },
    async dispose() {
      const running = await starting?.catch(() => null);
      starting = null;
      if (!running) return;
      const child = running.process;
      if (child.exitCode !== null || child.signalCode !== null) return;
      // The profile stays in use until the browser has really exited.
      const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
      await running.connection.send('Browser.close').catch(() => {});
      const timer = setTimeout(() => child.kill('SIGKILL'), 5_000);
      await exited;
      clearTimeout(timer);
    },
  };
}
