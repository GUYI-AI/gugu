import {
  type RecordCursor,
  type SessionpageSessionEvent,
  type SessionpageSessionSubscribeRequest,
} from '@gugu/session-core/session-record';
import { tapMainEvents } from '@main/lib/events';
import { onNativeMessagePreviewChanged } from './native-preview-events';
import { log } from '@main/lib/logger';
import {
  sessionChangedChannel,
} from '@shared/core/sessions/sessionEvents';
import { readSessionRow, recordReadable } from './session-rows';
import { acquire, entries, evict, fail, onRecordSourceFailed, release, type SessionTimelineResult, type TimelineEntry } from './timeline-entries';

/** 正文订阅:接上、跟着行换记录、记录源失败时的出口。 */

type ActiveSubscription = {
  conversationId: string;
  stop: () => void;
  fail?: (error: { code: string; message: string }) => void;
};

const subscriptions = new Map<string, ActiveSubscription>();

function recordSourceFailed(conversationId: string, error: unknown): void {
  const failure = { code: 'record_watch_failed', message: (error as Error)?.message ?? String(error) };
  for (const subscription of [...subscriptions.values()]) if (subscription.conversationId === conversationId) subscription.fail?.(failure);
  const entry = entries.get(conversationId);
  if (entry) evict(entry);
}
onRecordSourceFailed(recordSourceFailed);

/** Native card subscriptions observe identity-only invalidations, never a full timeline/live model. */
export async function subscribePreview(
  input: SessionpageSessionSubscribeRequest,
  changed: () => void,
): Promise<SessionTimelineResult<{ subscriptionId: string }>> {
  const row = readSessionRow(input.conversationId);
  if (!row || row.runtime !== 'acp') return subscribe(input, changed);
  const subscriptionId = input.subscriptionId?.trim();
  if (!subscriptionId) return fail('invalid_subscription', 'subscriptionId 是必填的');
  unsubscribe(subscriptionId);
  let stopped = false;
  const notify = () => { if (!stopped) changed(); };
  const stops = [
    onNativeMessagePreviewChanged(id => { if (id === undefined || id === input.conversationId) notify(); }),
    tapMainEvents((channel, data) => {
      if (channel === sessionChangedChannel.name && (data as { sessionId?: string }).sessionId === input.conversationId) notify();
    }),
  ];
  subscriptions.set(subscriptionId, { conversationId: input.conversationId, stop: () => {
    stopped = true;
    for (const stop of stops) stop();
  } });
  return { ok: true, value: { subscriptionId } };
}

/** 订阅正文；同一个 subscriptionId 重连会替换前一条。预览使用上面的独立入口。 */
export async function subscribe(
  input: SessionpageSessionSubscribeRequest,
  emit: (event: SessionpageSessionEvent) => void,
  status?: (event: import('@gugu/session-core/session-record/contract').SessionpageRecordStatusEvent) => void
): Promise<SessionTimelineResult<{ subscriptionId: string }>> {
  const subscriptionId = input.subscriptionId?.trim();
  if (!subscriptionId) return fail('invalid_subscription', 'subscriptionId 是必填的');

  // 先登记再等时间线:等的那一会儿里线断了 / 退订了,拆的就是这一条,回来时不再接上(❌ 给死掉的线留一条孤儿)。
  unsubscribe(subscriptionId);
  let stopped = false;
  let teardown: (() => void) | null = null;
  let attached: TimelineEntry | null = null;
  let stopFollow = () => {};
  const mine = {
    conversationId: input.conversationId,
    stop: () => {
      if (stopped) return;
      stopped = true;
      stopFollow();
      teardown?.();
    },
    fail: (error: { code: string; message: string }) => {
      if (stopped) return;
      status?.({ subscriptionId, error });
      mine.stop();
      forget();
    },
  };
  subscriptions.set(subscriptionId, mine);
  const forget = () => { if (subscriptions.get(subscriptionId) === mine) subscriptions.delete(subscriptionId); };

  const attach = async (cursor: RecordCursor | null): Promise<SessionTimelineResult<null>> => {
    const acquired = await acquire(input.conversationId);
    if (!acquired.ok) return acquired;
    const entry = acquired.value;
    if (stopped || entry === attached) {
      release(entry);
      return stopped ? fail('unsubscribed', '订阅在建好之前就被退掉了') : { ok: true, value: null };
    }
    let unsubscribeTimeline: () => void;
    try {
      unsubscribeTimeline = entry.timeline.subscribe(cursor ?? (input.recordEvents ? { epoch: 'initial-record', seq: 0 } : null), (result) => {
        if (stopped) return;
        emit({ subscriptionId, result });
      }, { terminalPatch: input.terminalPatch === true });
    } catch (error) {
      release(entry);
      return fail('subscribe_failed', (error as Error)?.message ?? String(error));
    }
    const previous = teardown;
    attached = entry;
    teardown = () => {
      try {
        unsubscribeTimeline();
      } finally {
        release(entry);
      }
    };
    previous?.();
    return { ok: true, value: null };
  };

  // The row moved to another agent record (see @@@record-moved), or got its first one while a stand-in was read:
  // follow it. A cursor from no epoch of the new timeline makes it answer with a reset and a whole snapshot, which the
  // viewer swaps in for what it holds.
  stopFollow = tapMainEvents((channel, data) => {
    if (channel !== sessionChangedChannel.name || !attached) return;
    const { sessionId, changes } = data as { sessionId?: string; changes?: { providerSessionId?: unknown } };
    if (sessionId !== input.conversationId) return;
    const next = changes?.providerSessionId;
    const moved = attached.standIn
      ? recordReadable(input.conversationId)
      : typeof next === 'string' && !!attached.providerSessionId && next !== attached.providerSessionId;
    if (!moved) return;
    void attach({ epoch: 'record-moved', seq: 0 }).then((result) => {
      // A record that is not there yet keeps its stand-in, which goes on asking (`recordAvailable`).
      if (!result.ok && result.error.code !== 'unsubscribed' && result.error.code !== 'record_not_found') {
        log.warn('sessionTimeline: following the moved record failed', { conversationId: input.conversationId, error: result.error });
      }
    });
  });

  const first = await attach(input.cursor);
  if (!first.ok) {
    stopFollow();
    forget();
    return first;
  }
  return { ok: true, value: { subscriptionId } };
}

export function unsubscribe(subscriptionId: string): void {
  const active = subscriptions.get(subscriptionId);
  if (!active) return;
  subscriptions.delete(subscriptionId);
  active.stop();
}

/** 频道断了：那一头的订阅一个都不再可达 —— 全清，❌ 不留着「以为还有人在看」的引用。 */
export function unsubscribeAll(): void {
  for (const subscriptionId of [...subscriptions.keys()]) unsubscribe(subscriptionId);
}
