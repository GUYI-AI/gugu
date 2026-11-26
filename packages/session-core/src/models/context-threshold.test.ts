import { expect, it } from 'vitest';
import {
  CONTEXT_THRESHOLD_ENV,
  CONTEXT_WINDOW_ENV,
  contextCompactionSettings,
  contextThresholdForWindow,
  contextTierChoice,
} from './context-threshold';

it('lowers a saved auto-compaction threshold strictly below a smaller window', () => {
  const previous = { tokens: 420_000, maximum: 600_000 };
  const next = contextThresholdForWindow(previous, 300_000);

  expect(next).toEqual({ tokens: 299_999, maximum: 300_000 });
  expect(contextCompactionSettings({
    [CONTEXT_THRESHOLD_ENV]: String(next.tokens),
    [CONTEXT_WINDOW_ENV]: String(next.maximum),
  }, 1_000_000)).toEqual({ tokens: 299_999, reserve: 700_001 });
});

it('sets the chosen cap for a session without saving a model preference', () => {
  const next = contextThresholdForWindow(undefined, 200_000);

  expect(next).toEqual({ tokens: 199_999, maximum: 200_000 });
  expect(contextCompactionSettings({
    [CONTEXT_THRESHOLD_ENV]: String(next.tokens),
    [CONTEXT_WINDOW_ENV]: String(next.maximum),
  }, 1_000_000)).toEqual({ tokens: 199_999, reserve: 800_001 });
});

// owner 11-27 02:38 / 02:35: 300K / 600K / 900K that fit, plus the maximum itself; 300K by default, the maximum when smaller.
it('offers the tiers under a max context plus the max, defaulting to 300K', () => {
  expect(contextTierChoice(1_000_000)).toEqual({ contextLengths: [300_000, 600_000, 900_000, 1_000_000], defaultContextLength: 300_000 });
  expect(contextTierChoice(600_000)).toEqual({ contextLengths: [300_000, 600_000], defaultContextLength: 300_000 });
  expect(contextTierChoice(400_000)).toEqual({ contextLengths: [300_000, 400_000], defaultContextLength: 300_000 });
  expect(contextTierChoice(200_000)).toEqual({ contextLengths: [200_000], defaultContextLength: 200_000 });
});
