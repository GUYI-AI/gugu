import { describe, expect, it } from 'vitest';
import type { TranscriptTurn } from '@gugu/session-core/acp/client';
import type { TimelineAfterResult } from '@gugu/session-core/session-record';
import { createStandInTimeline } from './stand-in-timeline';

const turn = (text: string): TranscriptTurn => ({
  id: 'runtime-1', seq: 0, initiator: 'user', items: [{ kind: 'message', id: 'm1', seq: 0, role: 'assistant', text }],
});

describe('stand-in timeline', () => {
  it('hands the runtime turn it shows to the record timeline before it tells the page to read the record', async () => {
    let tick = (): void => undefined;
    let available = false;
    const order: string[] = [];
    const handed: Array<[string, boolean]> = [];
    const timeline = createStandInTimeline({
      sessionId: 's1', firstMessage: 'hi', createdAt: null,
      recordAvailable: () => available,
      handOver: async (shown, running) => { handed.push([(shown.items[0] as { text: string }).text, running]); order.push('handOver'); },
      setInterval: (run) => { tick = run; return 1; },
      clearInterval: () => undefined,
    });
    const results: TimelineAfterResult[] = [];
    timeline.subscribe(timeline.getCursor(), (result) => { results.push(result); if (result.ok) order.push('replaced'); });

    timeline.syncActiveTurn(turn('streaming'));
    timeline.syncActiveTurn(turn('final'));
    timeline.syncActiveTurn(null);
    expect(timeline.getSnapshot({ limit: 10 })).toMatchObject({ runningTurnId: null });
    expect(timeline.getSnapshot({ limit: 10 }).turns.at(-1)?.items[0]).toMatchObject({ text: 'final' });

    available = true;
    tick();
    await new Promise((resolve) => setTimeout(resolve, 0));
    // The turn has ended: its last frame goes over as held, not running.
    expect(handed).toEqual([['final', false]]);
    expect(order).toEqual(['handOver', 'replaced']);
    expect(results.at(-1)).toMatchObject({ ok: true, batch: { cursor: { epoch: 'stand-in:s1:replaced' } } });
  });
});
