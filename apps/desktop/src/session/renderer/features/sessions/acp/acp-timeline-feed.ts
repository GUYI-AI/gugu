import type { TranscriptTurn } from '@gugu/session-core/acp/client';
import type { SessionpageSessionEvent, TimelineAfterResult } from '@gugu/session-core/session-record/contract';
import { applySnapshot, applyTimelineResult, emptyAgentWatchTimeline, prependOlder, type AgentWatchTimeline } from '@/components/session-watch/agent-watch-store';
import { sessionpageSessionTimelineChannel } from '@shared/core/session-timeline/sessionTimelineEvents';
import { onMachineEvent, rpcOn } from '@renderer/lib/ipc';
import { onMachineReconnected } from '@renderer/lib/machine-clients';

async function value<T>(result: Promise<{ ok: true; value: T } | { ok: false; error: { code: string; message: string } }>): Promise<T> {
  const next = await result;
  if (!next.ok) throw Object.assign(new Error(next.error.message), { code: next.error.code });
  return next.value;
}

/** The newest turns read when a page opens; older ones come a page at a time as the reader scrolls up. */
const FIRST_PAGE = 50;
const OLDER_PAGE = 100;

/**
 * A session page's history: the session's timeline, the one fold of its record (with the Gugu journal and the running
 * turn of its runtime) that every reader of a session uses. Read the way the session-watch page reads it: a snapshot,
 * then the batches the host pushes, older pages on demand. Nothing here knows whether the session runs: the timeline
 * goes on while the runtime starts, stops or is attached again.
 */
export class AcpTimelineFeed {
  state: AgentWatchTimeline = emptyAgentWatchTimeline();
  private readonly host: ReturnType<typeof rpcOn>['sessionTimeline'];
  /** This computer reads whole tool rows; another machine trims what it sends over the wire (`transport-trim`). */
  private readonly trim: boolean;
  private generation = 0;
  private subscription: { id: string; stop: () => void } | null = null;

  /** `machine` null = this computer. */
  constructor(
    private readonly sessionId: string,
    private readonly machine: string | null,
    private readonly changed: () => void,
    /** A read the feed started itself (a new snapshot after a gap or a reconnect) failed. */
    private readonly failed: (error: unknown) => void,
  ) {
    this.host = rpcOn(machine).sessionTimeline;
    this.trim = machine !== null;
  }

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
    // Listen before subscribing: a batch pushed between the answer and the listener would be lost.
    const stopEvents = onMachineEvent<SessionpageSessionEvent>(this.machine, { name: `${sessionpageSessionTimelineChannel.name}.${id}` }, (event) => {
      if (generation === this.generation && this.opened) this.apply(applyTimelineResult(this.state, event.result));
    });
    // Another machine's host drops its subscriptions with the link: follow again once it is back.
    const stopLink = this.machine ? onMachineReconnected(this.machine, () => {
      if (generation === this.generation) void this.open().catch(this.failed);
    }) : () => undefined;
    this.subscription = { id, stop: () => { stopEvents(); stopLink(); } };
    const snapshot = await value(this.host.sessionSnapshot({ conversationId, limit: FIRST_PAGE, trim: this.trim }));
    if (generation !== this.generation) return;
    this.state = applySnapshot(this.state, snapshot);
    this.changed();
    await value(this.host.sessionSubscribe({ conversationId, subscriptionId: id, cursor: snapshot.cursor, trim: this.trim, terminalPatch: true }));
  }

  /** Asks for what came after the cursor now, instead of waiting for the next push. */
  async catchUp(): Promise<void> {
    const generation = this.generation;
    const cursor = this.state.cursor;
    if (!cursor) return;
    const result: TimelineAfterResult = await value(this.host.sessionAfter({ conversationId: this.sessionId, cursor, trim: this.trim, terminalPatch: true }));
    if (generation === this.generation) this.apply(applyTimelineResult(this.state, result));
  }

  /** The page before the oldest turn held, oldest first; empty at the top. */
  async older(): Promise<TranscriptTurn[]> {
    const generation = this.generation;
    const first = this.state.turns[0];
    if (!this.state.hasOlder || !first) return [];
    const page = await value(this.host.sessionOlder({ conversationId: this.sessionId, beforeTurnId: first.id, limit: OLDER_PAGE, trim: this.trim }));
    if (generation !== this.generation) return [];
    const held = new Set(this.state.turns.map((turn) => turn.id));
    this.apply(prependOlder(this.state, page));
    return page.turns.filter((turn) => !held.has(turn.id));
  }

  toolImage(itemId: string, index: number) {
    return value(this.host.sessionToolImage({ conversationId: this.sessionId, itemId, index }));
  }

  /** Stops following and forgets what was read. */
  close(): void {
    this.restart();
    this.state = emptyAgentWatchTimeline();
  }

  private restart(): number {
    const generation = ++this.generation;
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
