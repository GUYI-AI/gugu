import type { SessionpageSessionEvent, SessionpageSessionWindowStatusEvent } from '@gugu/session-core/session-record/contract';
import {
  applyTimelineResult, emptyAgentWatchTimeline, type AgentWatchTimeline,
} from '@/mobile/agent-watch/agent-watch-store';

/** The local IPC adapter binds both event channels to this conversation and subscription. */
export interface AcpWindowHistoryClient {
  listen(conversationId: string, subscriptionId: string,
    receive: (event: SessionpageSessionEvent) => void, failed: (status: SessionpageSessionWindowStatusEvent) => void): () => void;
  subscribe(conversationId: string, subscriptionId: string): Promise<unknown>;
  unsubscribe(subscriptionId: string): Promise<unknown>;
}

export type AcpWindowView = {
  timeline: AgentWatchTimeline;
  phase: 'loading' | 'ready' | 'failed';
  error: unknown | null;
};
const emptyView = (): AcpWindowView => ({ timeline: emptyAgentWatchTimeline(), phase: 'loading', error: null });
const invalidWindow = (message: string) => Object.assign(new Error(message), { code: 'invalid_window' });

/** A single bounded history owner. It never reads an archive cache, retries, or changes source on failure. */
export class AcpWindowHistory {
  view: AcpWindowView = emptyView();
  private generation = 0;
  private subscriptionId: string | null = null;
  private stopListening: (() => void) | null = null;

  constructor(
    readonly conversationId: string,
    private readonly client: AcpWindowHistoryClient,
    private readonly changed: (view: AcpWindowView) => void,
    private readonly newId: () => string = () => crypto.randomUUID(),
  ) {}

  async open(): Promise<void> {
    this.close();
    const generation = this.generation;
    const subscriptionId = this.newId();
    this.subscriptionId = subscriptionId;
    this.publish(emptyView());
    const current = () => generation === this.generation && this.subscriptionId === subscriptionId;
    try {
      // Listen before asking: the host can emit its first snapshot before its subscribe ACK.
      const stop = this.client.listen(this.conversationId, subscriptionId, event => {
        if (!current() || event.subscriptionId !== subscriptionId) return;
        const result = event.result;
        if (!result.ok && (!result.snapshot.sourceLineage || !result.snapshot.snapshotRevision)) {
          this.fail(invalidWindow('The source window has no snapshot identity'));
          return;
        }
        if (result.ok && !this.view.timeline.cursor) {
          this.fail(invalidWindow('The source window has no initial snapshot'));
          return;
        }
        const timeline = applyTimelineResult(this.view.timeline, result);
        if (timeline.needsSnapshot) {
          this.fail(invalidWindow(`The source window cannot continue: ${timeline.needsSnapshot}`));
          return;
        }
        this.publish({ timeline, phase: 'ready', error: null });
      }, status => {
        if (current() && status.conversationId === this.conversationId && status.subscriptionId === subscriptionId) {
          this.fail(status.error);
        }
      });
      if (!current()) { stop(); return; }
      this.stopListening = stop;
      await this.client.subscribe(this.conversationId, subscriptionId);
      // A late setup ACK can create a subscription after its first unsubscribe already ran.
      if (!current()) this.release(subscriptionId);
    } catch (error) {
      if (current()) this.fail(error);
    }
  }

  /** Invalidate before releasing IPC resources; a physically pending promise cannot commit afterwards. */
  close(): void {
    this.generation++;
    const id = this.subscriptionId;
    this.subscriptionId = null;
    this.stopListening?.();
    this.stopListening = null;
    if (id) this.release(id);
  }

  private release(subscriptionId: string): void {
    void Promise.resolve().then(() => this.client.unsubscribe(subscriptionId)).catch(() => undefined);
  }

  private fail(error: unknown): void {
    // A window failure is terminal for this opening. Already painted bounded text remains readable.
    const timeline = this.view.timeline;
    this.close();
    this.publish({ timeline, phase: 'failed', error });
  }

  private publish(view: AcpWindowView): void {
    this.view = view;
    this.changed(view);
  }
}
