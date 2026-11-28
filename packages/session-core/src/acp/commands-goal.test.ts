import { describe, expect, it } from 'vitest';

import { goalAcceptsTokenBudget, parseGoalCommand } from './commands';

describe('parseGoalCommand', () => {
  it('reads the goal and its token budget', () => {
    expect(parseGoalCommand('/goal ship it')).toEqual({ kind: 'set', objective: 'ship it', tokenBudget: null });
    expect(parseGoalCommand('/goal --tokens 200000 ship it')).toEqual({ kind: 'set', objective: 'ship it', tokenBudget: 200_000 });
    expect(parseGoalCommand('/goal --tokens=1.5m ship\nit')).toEqual({ kind: 'set', objective: 'ship\nit', tokenBudget: 1_500_000 });
    expect(parseGoalCommand('  /goal --tokens 20K x')).toEqual({ kind: 'set', objective: 'x', tokenBudget: 20_000 });
  });

  it('reads the controls and the bare command', () => {
    expect(parseGoalCommand('/goal')).toEqual({ kind: 'show' });
    expect(parseGoalCommand('/goal Clear')).toEqual({ kind: 'clear' });
    expect(parseGoalCommand('/goal pause')).toEqual({ kind: 'pause' });
    expect(parseGoalCommand('/goal resume')).toEqual({ kind: 'resume' });
  });

  it('refuses a budget that is not a positive count, or a goal with no text', () => {
    expect(parseGoalCommand('/goal --tokens lots x')).toMatchObject({ kind: 'invalid' });
    expect(parseGoalCommand('/goal --tokens 0 x')).toMatchObject({ kind: 'invalid' });
    expect(parseGoalCommand('/goal --tokens')).toMatchObject({ kind: 'invalid' });
    expect(parseGoalCommand('/goal --tokens 10k')).toMatchObject({ kind: 'invalid' });
  });

  it('is not another command or prose', () => {
    expect(parseGoalCommand('/goals x')).toBeNull();
    expect(parseGoalCommand('set a /goal')).toBeNull();
  });
});

describe('goalAcceptsTokenBudget', () => {
  it('follows the hint the agent itself advertised for /goal', () => {
    expect(goalAcceptsTokenBudget([{ name: 'goal', inputHint: '[--tokens N] <goal> | clear' }])).toBe(true);
    expect(goalAcceptsTokenBudget([{ name: 'goal', inputHint: '[<condition> | clear]' }])).toBe(false);
    expect(goalAcceptsTokenBudget([])).toBe(false);
  });
});
