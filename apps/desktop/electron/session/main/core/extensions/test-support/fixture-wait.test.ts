import { describe, expect, it } from 'vitest';
import { untilObserved } from './fixture-wait';

const watch = (over: Partial<Parameters<typeof untilObserved>[1]> = {}) => ({ phase: 'phase', arrived: () => ({ n: 1 }), ...over });

describe('fixture observation wait', () => {
  it('returns once a synchronous or asynchronous condition holds, awaiting the promise rather than treating it as true', async () => {
    let sync = 0, async = 0;
    await untilObserved(() => ++sync > 3, watch());
    await untilObserved(async () => { await new Promise(resolve => setTimeout(resolve, 5)); return ++async > 2; }, watch());
    expect([sync, async]).toEqual([4, 3]);
  });
  it('ends only on a recorded fault, naming the phase, what had arrived and the cause', async () => {
    const fault = new Error('boom');
    await expect(untilObserved(async () => false, watch({ fault: () => fault })))
      .rejects.toMatchObject({ cause: fault, message: 'phase: Error: boom; arrived {"n":1}' });
  });
  it('ends when the peer process exited, with what it said', async () => {
    await expect(untilObserved(() => false, watch({ exited: () => 'stderr tail' })))
      .rejects.toThrow('phase: viewer exited before it was reached; arrived {"n":1}\nstderr tail');
  });
  it('does not hide a failing condition', async () => {
    await expect(untilObserved(async () => { throw new Error('read failed'); }, watch())).rejects.toThrow('read failed');
  });
});
