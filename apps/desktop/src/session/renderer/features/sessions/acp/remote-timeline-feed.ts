import type { TranscriptTurn } from '@gugu/session-core/acp/client';
import type { LeanPage, SessionpageSessionEvent } from '@gugu/session-core/session-record/contract';
import { emptyAgentWatchTimeline, prependOlder, type AgentWatchTimeline } from '@/components/session-watch/agent-watch-store';
import { createHeldTurnReader, FOLDED, withWholeTurns } from '@/components/session-watch/folded-pages';
import { sessionStreamKey, sessionStreams, type SessionStreamState } from '@/components/session-watch/timeline-cache';
import { followSessionStream, type TimelineStreamClient } from '@/components/session-watch/use-timeline-session';
import { sessionpageSessionTimelineChannel } from '@shared/core/session-timeline/sessionTimelineEvents';
import { onMachineEvent, rpcOn } from '@renderer/lib/ipc';
import { machineLinkState, onMachineReconnected, subscribeMachineLink } from '@renderer/lib/machine-clients';
import { value, type TimelineFeed } from './acp-timeline-feed';

const OLDER_PAGE = 100;

/** The stream's failure with its code: an unreachable machine stays a lost line the page reopens on (acp-load-error). */
function streamError(stream: SessionStreamState): Error {
  return Object.assign(new Error(stream.error ?? 'timeline unavailable'), stream.errorCode ? { code: stream.errorCode } : {});
}

/** That machine's timeline through this window's line to it (`rpcOn`), trimmed for the wire (`transport-trim`). */
function machineTimeline(machine: string) {
  const host = rpcOn(machine).sessionTimeline;
  const stream: TimelineStreamClient = {
    fetchSnapshot: (_device, conversationId, limit, lean) => value(host.sessionSnapshot({ conversationId, limit, trim: true, lean })),
    fetchAfter: (_device, conversationId, cursor, lean) => value(host.sessionAfter({ conversationId, cursor, trim: true, terminalPatch: true, lean })),
    subscribeSession: (_device, conversationId, subscriptionId, cursor, lean) =>
      value(host.sessionSubscribe({ conversationId, subscriptionId, cursor, trim: true, terminalPatch: true, lean })),
    unsubscribeSession: (_device, subscriptionId) => host.sessionUnsubscribe({ subscriptionId }),
    subscribeSessionEvents: (_device, id, receive) => onMachineEvent<SessionpageSessionEvent>(machine,
      { name: `${sessionpageSessionTimelineChannel.name}.${id}` }, (event) => receive(event.result)),
    // A new window = that machine dropped this window's subscriptions with the old one: the stream subscribes again. A
    // planned switch of channel opens one too, while the link state says open throughout (❌ watch only that state).
    onLinkChange: (_device, changed) => {
      const stopOpened = onMachineReconnected(machine, () => changed(true));
      let open = machineLinkState(machine) === 'open';
      const stopLost = subscribeMachineLink(machine, () => {
        const now = machineLinkState(machine) === 'open';
        if (open && !now) changed(false);
        open = now;
      });
      return () => { stopOpened(); stopLost(); };
    },
  };
  return {
    stream,
    older: (conversationId: string, beforeTurnId: string, limit?: number, lean?: LeanPage) =>
      value(host.sessionOlder({ conversationId, beforeTurnId, limit, trim: true, lean })),
  };
}

/**
 * The session page's history of a task on another machine: the session stream of that machine's session, the one the
 * page it opened on before its workspace was ready (and the phone) fills (`followSessionStream`). One copy per session:
 * when this page takes over from that one it continues from what that one held, ❌ reads the first page again. Pages
 * come folded (`folded-pages`); the stream re-subscribes on each new window to that machine and reads a snapshot after a reset.
 */
export class RemoteTimelineFeed implements TimelineFeed {
  private readonly key: { deviceId: string; sessionId: string };
  private readonly machine: ReturnType<typeof machineTimeline>;
  private reader: ReturnType<typeof followSessionStream> | null = null;
  private stopWatch: (() => void) | null = null;
  /** Settles an open still waiting when the page closes (the store checks its own generation after it). */
  private abandon: (() => void) | null = null;
  private generation = 0;
  readonly fillHeld: (itemId: string) => void;

  constructor(
    sessionId: string,
    deviceId: string,
    private readonly changed: () => void,
    /** The stream could not read that machine's timeline (after its own retries). */
    private readonly failed: (error: unknown) => void,
  ) {
    this.key = { deviceId, sessionId };
    this.machine = machineTimeline(deviceId);
    this.fillHeld = createHeldTurnReader({
      pages: {
        snapshot: (limit) => this.machine.stream.fetchSnapshot(deviceId, sessionId, limit),
        older: (beforeTurnId, limit) => this.machine.older(sessionId, beforeTurnId, limit),
      },
      turns: () => this.state.turns,
      land: (whole) => this.reader?.setTimeline((current) => ({ ...current, turns: withWholeTurns(current.turns, whole) })),
      failed,
    });
  }

  private get stream(): SessionStreamState | undefined {
    return sessionStreams.get()[sessionStreamKey(this.key)];
  }

  get state(): AgentWatchTimeline {
    return (this.reader && this.stream?.timeline) || emptyAgentWatchTimeline();
  }

  get opened(): boolean {
    return this.state.cursor !== null;
  }

  get hasOlder(): boolean {
    return this.state.hasOlder;
  }

  /** Follows the session's stream; settles once it holds a timeline (at once when the page before held one). */
  open(): Promise<void> {
    this.close();
    const reader = followSessionStream({ client: this.machine.stream, ...this.key, enabled: true, lean: FOLDED }, () => { this.generation++; });
    this.reader = reader;
    return new Promise((resolve, reject) => {
      let settled = false;
      let shown: AgentWatchTimeline | null = null;
      let error: string | null = null;
      this.abandon = () => { if (!settled) { settled = true; resolve(); } };
      const look = () => {
        const stream = this.stream;
        if (this.reader !== reader || !stream) return;
        if (stream.timeline !== shown && stream.timeline.cursor) {
          shown = stream.timeline;
          this.changed();
        }
        if (!settled && stream.phase !== 'loading') {
          settled = true;
          if (stream.phase === 'ready') resolve(); else reject(streamError(stream));
        } else if (settled && stream.error && stream.error !== error) this.failed(streamError(stream));
        error = stream.error;
      };
      this.stopWatch = sessionStreams.subscribe(look);
      look();
    });
  }

  catchUp(): Promise<void> {
    return this.reader?.catchUp() ?? Promise.resolve();
  }

  /** The page before the oldest turn held, oldest first; empty at the top. */
  async older(): Promise<TranscriptTurn[]> {
    const generation = this.generation;
    const first = this.state.turns[0];
    if (!this.reader || !this.state.hasOlder || !first) return [];
    const page = await this.machine.older(this.key.sessionId, first.id, OLDER_PAGE, FOLDED);
    if (generation !== this.generation || !this.reader) return [];
    const held = new Set(this.state.turns.map((turn) => turn.id));
    this.reader.setTimeline((current) => (current.turns[0]?.id === first.id ? prependOlder(current, page) : current));
    return page.turns.filter((turn) => !held.has(turn.id));
  }

  /** Stops reading the stream; the stream keeps its copy for the next reader of this session. */
  close(): void {
    this.generation++;
    this.abandon?.();
    this.abandon = null;
    this.stopWatch?.();
    this.stopWatch = null;
    this.reader?.detach();
    this.reader = null;
  }
}
