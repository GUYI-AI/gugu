/**
 * Chrome creates the window of a `window.open` before Gugu can say whether the page may have it, and starts loading the address
 * at once: a window Gugu then closes has already asked the site for its page, which spends a one-time link. So the windows
 * pages open are caught while they are being created: Chrome is told to hold a new page until the debugger lets it start
 * (`Target.setAutoAttach` with `waitForDebuggerOnStart`), and nothing is requested while it is held.
 *
 * That is a browser-wide switch, so it is as narrow as it can be made: only page targets are attached (service workers, shared
 * workers and cross-process iframes never are), and a page that no tab of Gugu's opened a window for (Gugu's own tabs, a page
 * nobody listens to) is let go the moment it is held, with no judgment. A window held for a tab gets Gugu's decision, and
 * whatever goes wrong, or when no decision comes in time, it is let go as Chrome made it and the reason is logged.
 */

type CdpEvent = { method?: string; params?: Record<string, unknown>; sessionId?: string };

export interface PauserConnection {
  send(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<unknown>;
  on(event: 'event', listener: (message: CdpEvent) => void): unknown;
  off(event: 'event', listener: (message: CdpEvent) => void): unknown;
}

export interface PauserLog {
  warn(message: string, fields?: object): void;
}

/** A page that hears about the windows it opens, and decides what becomes of each window Chrome holds. */
export interface WindowOwner {
  readonly targetId: string;
  /** Chrome holds `popup`, a window this page opened; `session` is the debugger session the hold belongs to. */
  windowPaused(popup: string, session: string): void;
}

/** How long a held window waits for Gugu's decision before it is let go as Chrome made it. */
export const WINDOW_DECISION_MS = 2_000;

/** The target or session is already gone: not worth a log line, the window closed itself. */
const GONE = /No target with given id|Session with given id not found|Target closed|Cannot find context|session closed/i;

export class WindowPauser {
  private readonly owners = new Map<string, WindowOwner>();
  private enabled = false;

  constructor(private readonly connection: PauserConnection, readonly log: PauserLog) {
    connection.on('event', this.onEvent);
  }

  /** From now on the windows this page opens are held for it. Switches the holding on once for the browser. */
  register(owner: WindowOwner): void {
    this.owners.set(owner.targetId, owner);
    if (this.enabled) return;
    this.enabled = true;
    this.connection.send('Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: true,
      filter: [{ type: 'page', exclude: false }, { exclude: true }],
    }).catch((error: unknown) => {
      this.enabled = false;
      this.log.warn('Chrome cannot hold the windows pages open; they open as Chrome makes them', { error: String(error) });
    });
  }

  unregister(owner: WindowOwner): void {
    if (this.owners.get(owner.targetId) === owner) this.owners.delete(owner.targetId);
  }

  /** Lets a held page start, then drops the debugger session that held it. Failures are logged unless the page is already gone. */
  async resume(session: string): Promise<void> {
    try {
      await this.connection.send('Runtime.runIfWaitingForDebugger', {}, session);
    } catch (error) {
      if (!GONE.test(String(error))) this.log.warn('Could not let a held window start', { error: String(error) });
      return;
    }
    await this.connection.send('Target.detachFromTarget', { sessionId: session }).catch(() => undefined);
  }

  private readonly onEvent = (message: CdpEvent) => {
    if (message.method !== 'Target.attachedToTarget' || message.sessionId !== undefined || !message.params?.waitingForDebugger) return;
    const info = message.params.targetInfo as { targetId?: string; type?: string; openerId?: string } | undefined;
    const session = String(message.params.sessionId);
    const owner = info?.type === 'page' && typeof info.openerId === 'string' ? this.owners.get(info.openerId) : undefined;
    if (!owner || !info?.targetId) { void this.resume(session); return; }
    try {
      owner.windowPaused(info.targetId, session);
    } catch (error) {
      this.log.warn('A held window could not be handed to its page', { error: String(error) });
      void this.resume(session);
    }
  };
}

const pausers = new WeakMap<object, WindowPauser>();

/** The one pauser of a browser connection. The first caller gives the log; a browser that logs makes it before any page asks. */
export function windowPauser(connection: PauserConnection, log: PauserLog = { warn: () => undefined }): WindowPauser {
  let pauser = pausers.get(connection);
  if (!pauser) { pauser = new WindowPauser(connection, log); pausers.set(connection, pauser); }
  return pauser;
}
