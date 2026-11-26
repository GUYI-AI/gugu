import { describe, expect, it, vi } from 'vitest';
import { reloadWorkingModel } from './reload-working-model';

describe('reconfiguring a model during a reply', () => {
  it('admits one continuation after the model change has been issued', async () => {
    const order: string[] = [];
    const continueTurn = vi.fn(() => { order.push('continue'); });
    await reloadWorkingModel({
      reload: async () => { order.push('reload'); return { ok: true }; },
      turnOutcome: () => 'cancelled',
      continueTurn,
    });
    expect(order).toEqual(['reload', 'continue']);
    expect(continueTurn).toHaveBeenCalledOnce();
  });

  it.each([
    { result: { ok: false, error: 'could not stop' }, outcome: 'cancelled' },
    { result: { ok: true, notStarted: true }, outcome: undefined },
    { result: { ok: true }, outcome: 'done' },
  ] as const)('does not queue continuation for $result and $outcome', async ({ result, outcome }) => {
    const continueTurn = vi.fn();
    expect(await reloadWorkingModel({
      reload: async () => result,
      turnOutcome: () => outcome,
      continueTurn,
    })).toEqual(result);
    expect(continueTurn).not.toHaveBeenCalled();
  });
});
