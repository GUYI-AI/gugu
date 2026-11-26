import { expect, it } from 'vitest';
import {
  CONTEXT_THRESHOLD_ENV,
  CONTEXT_WINDOW_ENV,
  contextCompactionSettings,
  contextThresholdForWindow,
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
