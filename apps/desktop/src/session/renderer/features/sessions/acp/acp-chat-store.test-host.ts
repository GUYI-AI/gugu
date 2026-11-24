// Shared host for the acp-chat-store tests (one copy instead of one per test file).
//
// ⚠️ `lib/ipc.ts` reads `window.electronAPI` while the module graph is being evaluated; without a bridge it
// installs a fail-loud stub, and `new AcpChatStore` → `getSharedChatContext()` → `preloadIssueMentionIcons`
// then throws `electronAPI.invoke is unavailable for integrations.list`. So the bridge has to be in place
// **before** the store module loads: call `installAcpChatStoreHost()` at the top level of the test file,
// then load the store with a dynamic `import('./acp-chat-store')` — never a static import, which would be
// hoisted above this call. Keep the call at the top level rather than in `beforeAll`: the import transforms
// the whole renderer graph and can outrun a hook budget under load, which turns every case into "skipped".
import { vi } from 'vitest';
import type { TranscriptTurn } from '@gugu/session-core/acp/client';

type Invoke = (channel: string, ...args: never[]) => Promise<unknown>;
type EventOn = (channel: string, callback: (data: unknown) => void) => () => void;

/**
 * The session's timeline every store in the file reads (`sessionTimeline.*` and its pushes): empty until a test shows
 * turns on it (`host.show`). It answers before the test's own `invoke` / `eventOn`.
 */
export const host = hostTimeline();

export function installAcpChatStoreHost(
  testInvoke: Invoke = () => Promise.resolve([]),
  testEventOn: EventOn = () => () => {},
): void {
  const invoke = ((channel: string, ...args: never[]) => host.invoke(channel) ?? testInvoke(channel, ...args)) as Invoke;
  const eventOn: EventOn = (channel, callback) => host.eventOn(channel, callback) ?? testEventOn(channel, callback);
  Object.defineProperty(document, 'fonts', {
    configurable: true,
    value: { load: vi.fn().mockResolvedValue([]) },
  });
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      invoke,
      eventSend: () => {},
      eventOn,
      getPathForFile: () => '',
    },
  });
}

type Meta = { kind: 'seed' } | { kind: 'update'; mutationIds: string[] };

/** An in-memory live replica: what the host pushes, the store reads through `current()` / `onChange`. */
export function replica<T>(initial: T) {
  let value = initial;
  const listeners = new Set<(value: T, meta: Meta) => void>();
  const goneListeners = new Set<(error: { code: string }) => void>();
  return {
    current: () => value,
    onChange: (cb: (value: T, meta: Meta) => void) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    onGone: (cb: (error: { code: string }) => void) => {
      goneListeners.add(cb);
      return () => goneListeners.delete(cb);
    },
    ready: Promise.resolve(),
    push(next: T, meta: Meta = { kind: 'update', mutationIds: [] }) {
      value = next;
      for (const listener of [...listeners]) listener(next, meta);
    },
    /** Reconnect refused for good: the runtime no longer has this instance (#7327). */
    gone() {
      for (const listener of [...goneListeners]) listener({ code: 'NOT_FOUND' });
    },
    listenerCount: () => listeners.size + goneListeners.size,
  };
}

/**
 * A session's timeline as this computer's host serves it (`sessionTimeline.*`): `invoke` answers the reads, `eventOn`
 * carries what it pushes. `show` replaces the turns (and the running one) and pushes them as a fresh snapshot, as a reset does.
 * Pass both to `installAcpChatStoreHost`, `invoke` first in line: it answers `undefined` for other channels.
 */
export function hostTimeline(initial: TranscriptTurn[] = []) {
  let turns = initial;
  let running: string | null | undefined;
  let seq = 0;
  const subscribers = new Map<string, (data: unknown) => void>();
  const snapshot = () => ({ cursor: { epoch: 'host', seq }, turns, settlements: [], hasOlder: false, runningTurnId: running });
  const answer = (value: unknown) => Promise.resolve({ ok: true, value });
  return {
    reads: [] as string[],
    /** When set, a snapshot read takes its turns from here (a test that holds, fails or pages the read). */
    read: null as null | (() => Promise<TranscriptTurn[]>),
    invoke(channel: string): Promise<unknown> | undefined {
      if (!channel.startsWith('sessionTimeline.')) return undefined;
      this.reads.push(channel);
      if (channel === 'sessionTimeline.sessionSnapshot') {
        if (!this.read) return answer(snapshot());
        return this.read().then((next) => { turns = next; seq += 1; return { ok: true, value: snapshot() }; });
      }
      if (channel === 'sessionTimeline.sessionAfter') return answer({ ok: false, reset: 'epoch_changed', snapshot: snapshot() });
      if (channel === 'sessionTimeline.sessionUnsubscribe') return Promise.resolve(null);
      return answer(null);
    },
    eventOn(channel: string, callback: (data: unknown) => void): (() => void) | undefined {
      if (!channel.startsWith('session-timeline:push.')) return undefined;
      subscribers.set(channel, callback);
      return () => subscribers.delete(channel);
    },
    /** `runningTurnId`: the turn the runtime is in; omitted, the host does not say (an older host). */
    show(next: TranscriptTurn[], runningTurnId?: string | null) {
      turns = next;
      running = runningTurnId;
      seq += 1;
      for (const [channel, callback] of [...subscribers]) {
        callback({ subscriptionId: channel.slice('session-timeline:push.'.length), result: { ok: false, reset: 'epoch_changed', snapshot: snapshot() } });
      }
    },
  };
}
