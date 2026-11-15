import { expect, expectTypeOf, it, vi } from 'vitest';
import type { SessionpageSessionEvent, SessionpageSessionWindowStatusEvent } from '@gugu/session-core/session-record/contract';
import { createEventEmitter } from '../../lib/ipc/events';
import { sessionpageSessionTimelineChannel, sessionpageSessionWindowStatusChannel } from './sessionTimelineEvents';

it('routes terminal window failures without invoking legacy reset consumers or another subscription', () => {
  const callbacks = new Map<string, (data: unknown) => void>();
  const events = createEventEmitter({
    on(name, callback) { callbacks.set(name, callback); return () => { callbacks.delete(name); }; },
    emit(name, data, topic) { callbacks.get(topic ? `${name}.${topic}` : name)?.(data); },
  });
  const windowFailed = vi.fn(), legacyReset = vi.fn(), anotherSubscription = vi.fn();
  events.on(sessionpageSessionWindowStatusChannel, windowFailed, 'generation-a');
  events.on(sessionpageSessionWindowStatusChannel, anotherSubscription, 'generation-b');
  events.on(sessionpageSessionTimelineChannel, legacyReset, 'generation-a');
  const failure: SessionpageSessionWindowStatusEvent = {
    conversationId: 'conversation-a', subscriptionId: 'generation-a', state: 'failed',
    error: { code: 'source_changed', message: 'The source changed during the window read' },
  };
  events.emit(sessionpageSessionWindowStatusChannel, failure, failure.subscriptionId);
  expect(windowFailed).toHaveBeenCalledExactlyOnceWith(failure);
  expect(legacyReset).not.toHaveBeenCalled();
  expect(anotherSubscription).not.toHaveBeenCalled();

  const success: SessionpageSessionEvent = { subscriptionId: 'generation-a', result: {
    ok: false, reset: 'epoch_changed', snapshot: {
      cursor: { epoch: 'source-a', seq: 0 }, turns: [], settlements: [], hasOlder: false,
    },
  } };
  events.emit(sessionpageSessionTimelineChannel, success, success.subscriptionId);
  expect(legacyReset).toHaveBeenCalledExactlyOnceWith(success);
  expect(windowFailed).toHaveBeenCalledTimes(1);
});

it('keeps failure status outside the legacy successful-read event contract', () => {
  expectTypeOf<SessionpageSessionWindowStatusEvent['state']>().toEqualTypeOf<'failed'>();
  expectTypeOf<SessionpageSessionWindowStatusEvent>().not.toMatchTypeOf<SessionpageSessionEvent>();
});
