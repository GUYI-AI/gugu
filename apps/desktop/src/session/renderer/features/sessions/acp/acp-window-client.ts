import { events, rpcOn } from '@renderer/lib/ipc';
import {
  sessionpageSessionTimelineChannel, sessionpageSessionWindowStatusChannel,
} from '@shared/core/session-timeline/sessionTimelineEvents';
import type { AcpWindowHistoryClient } from './acp-window-history';
import { windowLiveCursorSchema, type WindowCommitPage, type WindowLiveCursor } from '@gugu/session-wire/session-window-live';
import { createAcpWindowLiveReadClient } from './acp-window-live-client';
import { startAcpWindowCommitReader } from './acp-window-commit-reader';

/** This metadata-only decision must finish before any legacy history I/O. */
export async function prepareAcpWindowHistory(conversationId: string, subscriptionId: string) {
  const result = await rpcOn(null).sessionTimeline.sessionWindowPrepare({ conversationId, subscriptionId });
  if (!result.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code });
  return result.value.source === 'legacy' ? Object.freeze({ source: 'legacy' as const })
    : Object.freeze({ source: 'window' as const, liveCursor: Object.freeze(windowLiveCursorSchema.parse(result.value.liveCursor)) });
}

/** Bind only the endpoints registered by the host. Position is a separate capability. */
export function createAcpWindowLiveReadIpcClient(owner: { conversationId: string; subscriptionId: string }, current: () => boolean) {
  const api = rpcOn(null).sessionTimeline;
  return createAcpWindowLiveReadClient(owner, {
    read: input => api.sessionWindowLiveRead(input),
    ack: input => api.sessionWindowLiveAck(input),
  }, current);
}

/** Release the same prepared owner on close or failure, retaining the caller's
 * already painted state. Materialization must complete before the reader ACKs. */
export function startAcpWindowCommitIpc<Resident>(
  input: { conversationId: string; subscriptionId: string; after: WindowLiveCursor },
  port: { isCurrent(): boolean; materialize(page: WindowCommitPage): Promise<Resident>;
    commit(resident: Resident, page: WindowCommitPage): void; failed(error: unknown): void },
) {
  const owner = { conversationId: input.conversationId, subscriptionId: input.subscriptionId };
  let closed = false;
  const current = () => !closed && port.isCurrent();
  const client = createAcpWindowLiveReadIpcClient(owner, current);
  return startAcpWindowCommitReader(input.after, {
    read: client.read, cursor: page => page.next, materialize: page => port.materialize(page),
    commit(resident, page) {
      // Materialization awaits body pages after the RPC ownership check.
      if (!current()) throw Object.assign(new Error('The history view was released'), { code: 'unsubscribed' });
      port.commit(resident, page);
    }, ack: client.ack,
    release() { closed = true; void acpWindowHistoryClient.unsubscribe(owner.subscriptionId).catch(() => undefined); },
    failed(error) { if (port.isCurrent()) port.failed(error); },
  });
}

/** IPC envelope decoding belongs here, before an ACK reaches the history owner. */
export const acpWindowHistoryClient: AcpWindowHistoryClient = {
  listen: (_conversationId, subscriptionId, receive, failed) => {
    const off = events.on(sessionpageSessionTimelineChannel, receive, subscriptionId);
    try {
      const offStatus = events.on(sessionpageSessionWindowStatusChannel, failed, subscriptionId);
      return () => { off(); offStatus(); };
    } catch (error) {
      off();
      throw error;
    }
  },
  subscribe: async (conversationId, subscriptionId) => {
    const result = await rpcOn(null).sessionTimeline.sessionWindowSubscribe({
      conversationId, subscriptionId, cursor: null, trim: false,
    });
    if (!result.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code });
    return result.value;
  },
  unsubscribe: subscriptionId => rpcOn(null).sessionTimeline.sessionUnsubscribe({ subscriptionId }),
};
