/** The captured 388-entry / 169,103-token request puts 120k at roughly 275 entries. */
export const ASSISTANT_IDLE_COMPACT_TOKENS = 120_000;
/** Run before the cloud host's ordinary idle suspension, without waking it for maintenance. */
export const ASSISTANT_IDLE_COMPACT_MS = 60_000;

/**
 * #3005 Claude Code's own idle compaction, which its stream-json/ACP mode never runs: before the one-hour prompt
 * cache expires. 50 min idle, and no compaction once the last real request is over 55 min old: the compaction
 * request itself needs a still-warm cache with room to spare (owner 11-18: 59 min was too tight).
 */
export const CLAUDE_CACHE_IDLE_COMPACT_MS = 50 * 60_000;
export const CLAUDE_CACHE_LAST_REQUEST_MAX_AGE_MS = 55 * 60_000;
/** Claude Code's default `CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS`, and its floor. */
export const CLAUDE_CACHE_IDLE_COMPACT_TOKENS = 200_000;
export const CLAUDE_CACHE_IDLE_COMPACT_MIN_TOKENS_FLOOR = 100_000;

/** A timer that fires this late was frozen (sleep / suspended host): the window it guarded is gone. */
const LATE_FIRE_GRACE_MS = 5_000;

export interface IdleCompactionPolicy {
  delayMs: number;
  minTokens: number;
  /**
   * `idle`: count from when the session was seen idle (the assistant's host-suspension race).
   * `lastWork`: count from the end of the last live model cycle — the prompt cache is refreshed by the last
   * request, so a session reopened from history (no live work yet) is never compacted on a cold cache.
   */
  anchor: 'idle' | 'lastWork';
}

export const ASSISTANT_IDLE_COMPACTION: IdleCompactionPolicy = {
  delayMs: ASSISTANT_IDLE_COMPACT_MS, minTokens: ASSISTANT_IDLE_COMPACT_TOKENS, anchor: 'idle',
};

export function claudeCacheIdleCompaction(minTokens = CLAUDE_CACHE_IDLE_COMPACT_TOKENS): IdleCompactionPolicy {
  return { delayMs: CLAUDE_CACHE_IDLE_COMPACT_MS, minTokens, anchor: 'lastWork' };
}

export interface IdleCompactionState {
  idle: boolean;
  contextTokens: number | null;
  /** Changes only when real input or a native history load is admitted. */
  revision: number;
  /** Epoch ms the last live model cycle settled; null before any live work in this process. */
  lastWorkEndedAt?: number | null;
}

/** A live-session timer, never a persistent job or a reason to start/resume an engine. */
export class IdleCompaction {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private timerAnchor: number | null = null;
  private attemptedRevision: number | null = null;
  private closed = false;

  constructor(
    private readonly read: () => IdleCompactionState,
    private readonly compact: () => Promise<void>,
    private readonly failed: (error: unknown) => void = () => undefined,
    private readonly policy: IdleCompactionPolicy = ASSISTANT_IDLE_COMPACTION,
  ) {}

  update(): void {
    if (this.closed) return;
    const state = this.read();
    if (!this.eligible(state)) { this.clear(); return; }
    const anchor = this.policy.anchor === 'lastWork' ? state.lastWorkEndedAt! : null;
    if (this.timer && this.timerAnchor === anchor) return;
    this.clear();
    const revision = state.revision;
    const deadline = (anchor ?? Date.now()) + this.policy.delayMs;
    const wait = deadline - Date.now();
    // The cache this would have protected has already expired: compacting now only adds a full-price read.
    if (wait < -LATE_FIRE_GRACE_MS) return;
    this.timerAnchor = anchor;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.timerAnchor = null;
      const current = this.read();
      // A frozen/suspended process must not compact on wake before its waiting inbox arrives.
      if (Date.now() > deadline + LATE_FIRE_GRACE_MS) { this.update(); return; }
      if (this.closed || !this.eligible(current) || current.revision !== revision
        || (anchor !== null && current.lastWorkEndedAt !== anchor)) {
        this.update();
        return;
      }
      // Failed commands, and stale usage readings after successful compaction, cannot spin.
      this.attemptedRevision = revision;
      void this.compact().catch(this.failed);
    }, Math.max(0, wait));
    this.timer.unref?.();
  }

  close(): void { this.closed = true; this.clear(); }

  private eligible(state: IdleCompactionState): boolean {
    return state.idle && state.contextTokens !== null
      && state.contextTokens >= this.policy.minTokens
      && state.revision !== this.attemptedRevision
      && (this.policy.anchor === 'idle' || typeof state.lastWorkEndedAt === 'number');
  }

  private clear(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.timerAnchor = null;
  }
}
