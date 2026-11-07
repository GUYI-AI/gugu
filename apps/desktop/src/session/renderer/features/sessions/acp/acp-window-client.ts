import { events, rpcOn } from '@renderer/lib/ipc';
import {
  sessionpageSessionTimelineChannel, sessionpageSessionWindowStatusChannel,
} from '@shared/core/session-timeline/sessionTimelineEvents';
import type { AcpWindowHistoryClient } from './acp-window-history';

/** This metadata-only decision must finish before any legacy history I/O. */
export async function prepareAcpWindowHistory(conversationId: string, subscriptionId: string): Promise<'window' | 'legacy'> {
  const result = await rpcOn(null).sessionTimeline.sessionWindowPrepare({ conversationId, subscriptionId });
  if (!result.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code });
  return result.value.source;
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
