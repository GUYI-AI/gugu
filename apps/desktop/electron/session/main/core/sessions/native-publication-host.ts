import { onNativePublicationQueued, pendingNativePublications, saveNativePublication, nativeHistoryFloorCache, saveNativeHistoryFloor, type NativePublication, type NativePublicationContext } from './native-publication-journal';
import { historyTime } from '@gugu/core/shared/conversationHistoryTime';
import { events } from '@main/lib/events';
import { nativePersonalPublicationChannel } from '@shared/core/sessions/sessionEvents';
import { readDeliveryEnvelope } from '@gugu/core/local/agent/deliveryEnvelope';

let currentHost: { context(sessionId: string): Promise<NativePublicationContext | null>; historyFloor?(sessionId: string): Promise<string | null> } | null = null;
const readingFloors = new Map<string, Promise<string | null>>();
export async function nativeConversationHistoryFloor(sessionId: string): Promise<string | null> {
  const host = currentHost;
  if (!host?.historyFloor) return null;
  const owner = await host.context(sessionId);
  if (!owner) return null;
  const key = JSON.stringify([owner.ownerUserId, sessionId]);
  if (readingFloors.has(key)) return readingFloors.get(key)!;
  const read = (async () => {
    const cached = nativeHistoryFloorCache(owner.ownerUserId, sessionId);
    try {
      const incoming = await host.historyFloor!(sessionId);
      const floor = cached?.floor && (!incoming || historyTime(cached.floor) > historyTime(incoming)) ? cached.floor : incoming;
      saveNativeHistoryFloor(owner.ownerUserId, sessionId, floor);
      return floor;
    } catch (error) {
      if (cached && /fetch failed|failed to fetch|network|timeout/i.test(String(error))) return cached.floor;
      throw error;
    }
  })().finally(() => { readingFloors.delete(key); });
  readingFloors.set(key, read);
  return read;
}
export async function nativePublicationContext(sessionId: string, requireOwner = false): Promise<NativePublicationContext | null> {
  const host = currentHost;
  const context = await host?.context(sessionId) ?? null;
  if (requireOwner && host && !context) throw new Error('Native publication owner is not authenticated');
  return context;
}

/** Task-page session-direct inputs are personal too; background deliveries never borrow that identity. */
export async function nativePersonalInputContext(input: {
  sessionId: string; text: string; kind?: 'ordinary' | 'session-direct';
  delivery?: { origin?: string }; sourceInput?: unknown;
}): Promise<NativePublicationContext | null> {
  const manual = input.delivery?.origin === 'manual' || input.sourceInput !== undefined;
  return !readDeliveryEnvelope(input.text) && (manual || input.kind !== 'session-direct' && !input.delivery?.origin)
    ? nativePublicationContext(input.sessionId) : null;
}

/** Startup drains only explicit durable live admissions, never scans transcripts or activity previews. */
export function startNativeConversationPublicationHost(deps: {
  context(sessionId: string): Promise<NativePublicationContext | null>;
  address(entry: NativePublication): Promise<{ chatId: string; agentUserId: string }>;
  publish(entry: NativePublication & { chatId: string; agentUserId: string }): Promise<{ accountRevision: string; already: boolean }>;
  failed(error: unknown): void;
  historyFloor?(sessionId: string): Promise<string | null>;
}) {
  if (currentHost) throw new Error('Native conversation publication host is already running');
  currentHost = deps;
  let stopped = false, requested = false;
  let running: Promise<void> | null = null;
  let retry: ReturnType<typeof setTimeout> | undefined;
  const reported = new Set<string>();
  const flush = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (running) return running;
    clearTimeout(retry);
    running = (async () => {
      do {
        requested = false;
        for (const original of pendingNativePublications()) {
          if (stopped) break;
          try {
            const context = await deps.context(original.sessionId);
            if (!context || context.ownerUserId !== original.ownerUserId) continue;
            if (context.deviceId !== original.deviceId || original.agentUserId && context.agentUserId !== original.agentUserId) throw new Error('Native publication binding changed');
            const address = original.chatId && original.agentUserId
              ? { chatId: original.chatId, agentUserId: original.agentUserId } : await deps.address(original);
            if (stopped) break;
            const entry = { ...original, ...address };
            // Freeze the complete destination before an uncertain HTTP attempt, including after a crash.
            saveNativePublication(entry);
            const ack = await deps.publish(entry);
            if (!/^(0|[1-9][0-9]*)$/.test(ack.accountRevision) || typeof ack.already !== 'boolean') throw new Error('Invalid native publication receipt');
            saveNativePublication({ ...entry, ack });
            events.emit(nativePersonalPublicationChannel, { accountId: entry.ownerUserId, revision: ack.accountRevision });
            reported.delete(entry.id);
          } catch (error) {
            if (!reported.has(original.id)) { reported.add(original.id); deps.failed(error); }
          }
        }
      } while (requested && !stopped);
    })().finally(() => {
      running = null;
      if (!stopped && pendingNativePublications().length) { retry = setTimeout(kick, 15_000); retry.unref?.(); }
    });
    return running;
  };
  const kick = () => { requested = true; void flush().catch(deps.failed); };
  const unlisten = onNativePublicationQueued(kick);
  kick();
  return { flush, dispose() { stopped = true; clearTimeout(retry); unlisten(); if (currentHost === deps) currentHost = null; } };
}
