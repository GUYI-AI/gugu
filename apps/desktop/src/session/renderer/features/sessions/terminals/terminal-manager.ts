import type { IDisposable } from '@gugu/session-shared';
import { computed, makeObservable, observable, reaction, runInAction } from 'mobx';
import { getAppSettingValueSnapshot } from '@renderer/features/settings/app-settings-client';
import { makeFileLinkHandlers } from '@renderer/features/sessions/stores/open-file-in-file-editor';
import { rpc } from '@renderer/lib/ipc';
import { PtySession } from '@renderer/lib/pty/pty-session';
import { Resource } from '@renderer/lib/stores/resource';
import { makePtySessionId } from '@shared/core/pty/ptySessionId';
import type { TerminalShellId } from '@shared/core/terminals/terminal-settings';
import { type CreateTerminalParams, type Terminal } from '@shared/core/terminals/terminals';
import { nextTerminalName } from './terminal-tabs';

export class TerminalManagerStore implements IDisposable {
  readonly projectId: string;
  readonly sessionId: string;
  /** Data layer: plain Terminal records loaded from the main process. */
  readonly list: Resource<Terminal[]>;
  /** Data stores keyed by terminal id — populated by reaction on list.data. */
  terminals = observable.map<string, TerminalStore>();
  /** Session layer keyed by terminal id — created alongside data, connected lazily. */
  sessions = observable.map<string, PtySession>();
  private readonly _disposeReaction: () => void;
  /** New terminals whose shell has not started yet: the tab is open, the record only exists here. */
  private readonly _starting = new Map<string, { gridMeasured(dims?: { cols: number; rows: number }): void; created: Promise<Terminal | undefined> }>();

  constructor(projectId: string, sessionId: string) {
    this.projectId = projectId;
    this.sessionId = sessionId;

    this.list = new Resource<Terminal[]>(
      () => rpc.terminals.getTerminalsForSession(sessionId),
      [{ kind: 'demand' }]
    );

    makeObservable(this, {
      terminals: observable,
      sessions: observable,
      isLoaded: computed,
    });

    // Sync terminals and sessions maps whenever the resource data changes.
    // fireImmediately ensures the reaction runs once on construction to establish
    // the dependency on list.data, which triggers the demand-strategy load.
    this._disposeReaction = reaction(
      () => this.list.data,
      (data) => {
        if (!data) return;
        runInAction(() => {
          const incomingIds = new Set(data.map((t) => t.id));

          // Add new entries (no connect()).
          for (const terminal of data) {
            if (!this.terminals.has(terminal.id)) {
              this.terminals.set(terminal.id, new TerminalStore(terminal));
            }
            if (!this.sessions.has(terminal.id)) {
              this.sessions.set(terminal.id, this.createSession(terminal));
            }
          }

          // Remove stale entries.
          const staleIds = Array.from(this.terminals.keys()).filter((id) => !incomingIds.has(id) && !this._starting.has(id));
          for (const id of staleIds) {
            this.sessions.get(id)?.destroy();
            this.sessions.delete(id);
            this.terminals.delete(id);
          }
        });
      },
      { fireImmediately: true }
    );
  }

  get isLoaded(): boolean {
    return this.list.data !== null;
  }

  /**
   * @@@spawn-at-measured-grid - the record exists at once, so the tab opens without waiting for a process. The shell starts when
   * the xterm in that tab has measured its grid: a shell started at a default size and resized while printing its first prompt
   * leaves that prompt cut off or zsh's stray `%`, and the half-width pane beside a conversation is always a resize away from it.
   * The xterm reports `undefined` if it cannot measure at all, and the shell then starts at the default size. A tab that is
   * never on screen starts no shell. `created` settles when the shell has started; undefined = the terminal was closed first.
   */
  createTerminal(params: CreateTerminalParams): { id: string; created: Promise<Terminal | undefined> } {
    const defaultShell = getAppSettingValueSnapshot('terminal')?.defaultShell ?? 'system';
    const optimistic: Terminal = {
      id: params.id,
      projectId: params.projectId,
      sessionId: params.sessionId,
      shellId: params.shell ?? defaultShell,
      name: params.name,
    };
    let gridMeasured!: (dims?: { cols: number; rows: number }) => void;
    const grid = new Promise<{ cols: number; rows: number } | undefined>((resolve) => {
      gridMeasured = resolve;
    });
    const created = grid
      .then(async (initialSize) => {
        if (!this.terminals.has(params.id)) return undefined;
        const terminal = await rpc.terminals.createTerminal(initialSize ? { ...params, initialSize } : params);
        runInAction(() => {
          const store = this.terminals.get(params.id);
          if (store) Object.assign(store.data, terminal);
        });
        return terminal;
      })
      .catch((error: unknown) => {
        runInAction(() => {
          this.sessions.get(params.id)?.destroy();
          this.sessions.delete(params.id);
          this.terminals.delete(params.id);
        });
        throw error;
      })
      .finally(() => {
        this._starting.delete(params.id);
      });
    this._starting.set(params.id, { gridMeasured, created });
    runInAction(() => {
      this.terminals.set(params.id, new TerminalStore(optimistic));
      this.sessions.set(params.id, this.createSession(optimistic));
    });
    return { id: params.id, created };
  }

  createDefaultTerminal(shell?: TerminalShellId): { id: string; created: Promise<Terminal | undefined> } {
    const names = Array.from(this.terminals.values()).map((t) => t.data.name);
    const name = nextTerminalName(names);
    const id = crypto.randomUUID();
    const params: CreateTerminalParams = {
      id,
      projectId: this.projectId,
      sessionId: this.sessionId,
      name,
    };
    if (shell !== undefined) params.shell = shell;
    return this.createTerminal(params);
  }

  async deleteTerminal(terminalId: string): Promise<void> {
    const store = this.terminals.get(terminalId);
    const session = this.sessions.get(terminalId);
    if (!store) return;

    runInAction(() => {
      this.terminals.delete(terminalId);
      this.sessions.delete(terminalId);
    });

    try {
      // Closed while its shell is still starting: end it after it has started, or the delete finds nothing and the shell lives on.
      const starting = this._starting.get(terminalId);
      starting?.gridMeasured();
      await starting?.created.catch(() => undefined);
      await rpc.terminals.deleteTerminal({
        projectId: this.projectId,
        sessionId: this.sessionId,
        terminalId,
      });
      session?.destroy();
    } catch (err) {
      runInAction(() => {
        this.terminals.set(terminalId, store);
        if (session) this.sessions.set(terminalId, session);
      });
      throw err;
    }
  }

  async hydrateTerminal(terminalId: string): Promise<void> {
    const store = this.terminals.get(terminalId);
    if (!store) return;
    await rpc.terminals.hydrateTerminal({
      projectId: this.projectId,
      sessionId: this.sessionId,
      terminalId,
    });
  }

  dispose(): void {
    this._disposeReaction();
    for (const session of this.sessions.values()) {
      session.destroy();
    }
    this.list.dispose();
  }

  async renameTerminal(terminalId: string, name: string): Promise<void> {
    const store = this.terminals.get(terminalId);
    if (!store) return;

    const previousName = store.data.name;

    runInAction(() => {
      store.data.name = name;
    });

    try {
      await rpc.terminals.renameTerminal(terminalId, name);
    } catch (err) {
      runInAction(() => {
        store.data.name = previousName;
      });
      throw err;
    }
  }

  private createSession(terminal: Terminal): PtySession {
    const handlers = makeFileLinkHandlers(terminal.projectId, terminal.sessionId);
    return new PtySession(
      makePtySessionId(terminal.projectId, terminal.sessionId, terminal.id),
      async () => {
        if (!this._starting.has(terminal.id)) await this.hydrateTerminal(terminal.id);
      },
      handlers.onOpenFile,
      handlers.onOpenExternal,
      { onGridMeasured: (dims) => this._starting.get(terminal.id)?.gridMeasured(dims) }
    );
  }
}

export class TerminalStore {
  data: Terminal;

  constructor(terminal: Terminal) {
    this.data = terminal;
    makeObservable(this, { data: observable });
  }
}
