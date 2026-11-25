import type { TranscriptTurn } from '@gugu/session-core/acp/client';
import type { SessionpageRecordStatusEvent, SessionpageSessionEvent, TimelineAfterResult } from '@gugu/session-core/session-record/contract';
import { applySnapshot, applyTimelineResult, emptyAgentWatchTimeline, prependOlder, type AgentWatchTimeline } from '@/components/session-watch/agent-watch-store';
import { sessionpageRecordStatusChannel, sessionpageSessionTimelineChannel } from '@shared/core/session-timeline/sessionTimelineEvents';
import { onMachineEvent, rpcOn } from '@renderer/lib/ipc';

export async function value<T>(result: Promise<{ ok: true; value: T } | { ok: false; error: { code: string; message: string } }>): Promise<T> {
  const next = await result;
  if (!next.ok) throw Object.assign(new Error(next.error.message), { code: next.error.code });
  return next.value;
}

/** The newest turns read when a page opens; older ones come a page at a time as the reader scrolls up. */
const OLDER_PAGE = 100;
const FIRST_PAGE = 50;

/**
 * A session page's history: the session's timeline, the one fold of its record (with the Gugu journal and the running
 * turn of its runtime) that every reader of a session uses. Nothing here knows whether the session runs: the timeline
 * goes on while the runtime starts, stops or is attached again.
 */
export interface TimelineFeed {
  readonly state: AgentWatchTimeline;
  readonly opened: boolean;
  readonly hasOlder: boolean;
  /** Reads the timeline and follows it. A failed read rejects; what was shown stays. */
  open(): Promise<void>;
  /** Asks for what came after the cursor now, instead of waiting for the next push. */
  catchUp(): Promise<void>;
  /** The page before the oldest turn held, oldest first; empty at the top. */
  older(): Promise<TranscriptTurn[]>;
  /** A row of a turn sent folded came on screen from behind a fold: read that turn whole (`folded-pages`). */
  readonly fillHeld: (itemId: string) => void;
  /** Stops following. */
  close(): void;
}

/**
 * The history of a session on this computer, read from its own host: a snapshot, then the batches the host pushes,
 * older pages on demand, every tool row whole (nothing crosses a link). A session on another machine reads the stream
 * its machine's pages share instead (`RemoteTimelineFeed`).
 */
export class AcpTimelineFeed implements TimelineFeed {
  state: AgentWatchTimeline = emptyAgentWatchTimeline();
  private readonly host = rpcOn(null).sessionTimeline;
  private generation = 0;
  private subscription: { id: string; stop: () => void } | null = null;
  private abandon: (() => void) | null = null;
  /** Pages of this computer are whole: nothing is held back, nothing to read again. */
  readonly fillHeld = (): void => undefined;

  constructor(
    private readonly sessionId: string,
    private readonly changed: () => void,
    /** A read the feed started itself (a new snapshot after a gap) failed. */
    private readonly failed: (error: unknown) => void,
    private readonly eventDriven: () => boolean = () => false,
  ) {}

  get opened(): boolean {
    return this.state.cursor !== null;
  }

  get hasOlder(): boolean {
    return this.state.hasOlder;
  }

  /** Reads the snapshot and follows the session from it. A failed read rejects; what was shown stays. */
  async open(): Promise<void> {
    const generation = this.restart();
    const id = globalThis.crypto.randomUUID();
    const conversationId = this.sessionId;
    if (!this.eventDriven()) {
      const stopEvents = onMachineEvent<SessionpageSessionEvent>(null, { name: `${sessionpageSessionTimelineChannel.name}.${id}` }, event => {
        if (generation === this.generation && this.opened) this.apply(applyTimelineResult(this.state, event.result));
      });
      this.subscription = { id, stop: stopEvents };
      const snapshot = await value(this.host.sessionSnapshot({ conversationId, limit: FIRST_PAGE }));
      if (generation !== this.generation) return;
      this.state = applySnapshot(this.state, snapshot);
      this.changed();
      await value(this.host.sessionSubscribe({ conversationId, subscriptionId: id, cursor: snapshot.cursor, terminalPatch: true }));
      return;
    }
    // Listen before subscribing: a batch pushed between the answer and the listener would be lost.
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const firstPush = new Promise<void>((accept, fail) => { resolve = accept; reject = fail; });
    // Install the rejection handler now: the host may fail before its subscribe acknowledgement arrives.
    void firstPush.catch(() => undefined);
    this.abandon = resolve;
    let received = false;
    const stopEvents = onMachineEvent<SessionpageSessionEvent>(null, { name: `${sessionpageSessionTimelineChannel.name}.${id}` }, (event) => {
      if (generation !== this.generation) return;
      this.apply(applyTimelineResult(this.state, event.result));
      received = true;
      resolve();
    });
    const stopStatus = onMachineEvent<SessionpageRecordStatusEvent>(null, { name: `${sessionpageRecordStatusChannel.name}.${id}` }, event => {
      if (generation !== this.generation || !event.error) return;
      const error = Object.assign(new Error(event.error.message), { code: event.error.code });
      if (received) this.failed(error); else reject(error);
    });
    this.subscription = { id, stop: () => { stopEvents(); stopStatus(); } };
    try {
      await value(this.host.sessionSubscribe({ conversationId, subscriptionId: id, cursor: null, terminalPatch: true, recordEvents: true }));
      if (generation === this.generation) await firstPush;
    } catch (error) {
      if (generation === this.generation) { this.restart(); throw error; }
    } finally { if (generation === this.generation) this.abandon = null; }
  }

  /** Asks for what came after the cursor now, instead of waiting for the next push. */
  async catchUp(): Promise<void> {
    const generation = this.generation;
    const cursor = this.state.cursor;
    if (!cursor) return;
    const result: TimelineAfterResult = await value(this.host.sessionAfter({ conversationId: this.sessionId, cursor, terminalPatch: true }));
    if (generation === this.generation) this.apply(applyTimelineResult(this.state, result));
  }

  /** The page before the oldest turn held, oldest first; empty at the top. */
  async older(): Promise<TranscriptTurn[]> {
    const generation = this.generation;
    const first = this.state.turns[0];
    if (!this.state.hasOlder || !first) return [];
    const page = await value(this.host.sessionOlder({ conversationId: this.sessionId, beforeTurnId: first.id, limit: OLDER_PAGE }));
    if (generation !== this.generation) return [];
    const held = new Set(this.state.turns.map((turn) => turn.id));
    this.apply(prependOlder(this.state, page));
    return page.turns.filter((turn) => !held.has(turn.id));
  }

  /** Stops following and forgets what was read. */
  close(): void {
    this.restart();
    this.state = emptyAgentWatchTimeline();
  }

  private restart(): number {
    const generation = ++this.generation;
    this.abandon?.();
    this.abandon = null;
    const previous = this.subscription;
    this.subscription = null;
    if (previous) {
      previous.stop();
      // Best effort: the page has gone; a failed unsubscribe only leaves the host pushing a while to no one.
      void this.host.sessionUnsubscribe({ subscriptionId: previous.id }).catch(() => undefined);
    }
    return generation;
  }

  private apply(next: AgentWatchTimeline): void {
    // A batch of another generation, or one after a gap: what is held cannot be continued, read the snapshot again.
    if (next.needsSnapshot) {
      void this.open().catch(this.failed);
      return;
    }
    this.state = next;
    this.changed();
  }
}
