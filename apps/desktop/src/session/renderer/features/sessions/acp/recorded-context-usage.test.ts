import { describe, expect, it } from 'vitest';
import { recordedContextUsage } from './recorded-context-usage';

const record = {
  providerSessionId: 'native-1',
  contextUsage: { used: 11_092, size: 1_000_000, modelId: 'glm-5.3-flash', providerSessionId: 'native-1' },
};

describe('recordedContextUsage: the last reading on the record, for a session that is not live', () => {
  it('same model: the reading as recorded', () => {
    expect(recordedContextUsage(record, 'glm-5.3-flash')).toEqual({ contextUsed: 11_092, contextSize: 1_000_000, cost: null });
  });

  it('model not known yet: the reading as recorded', () => {
    expect(recordedContextUsage(record, null)).toEqual({ contextUsed: 11_092, contextSize: 1_000_000, cost: null });
  });

  it('switched model: the tokens used so far, over the current model’s window', () => {
    expect(recordedContextUsage(record, 'glm-5.3', 200_000)).toEqual({ contextUsed: 11_092, contextSize: 200_000, cost: null });
  });

  it('switched model whose window is unknown: no number', () => {
    expect(recordedContextUsage(record, 'glm-5.3')).toBeNull();
    expect(recordedContextUsage(record, 'glm-5.3', 0)).toBeNull();
  });

  it('a reading of another native session (retried, or billing route changed) is never shown', () => {
    expect(recordedContextUsage({ ...record, providerSessionId: 'native-2' }, 'glm-5.3-flash', 200_000)).toBeNull();
  });

  it('no reading on the record: nothing', () => {
    expect(recordedContextUsage({ providerSessionId: 'native-1', contextUsage: undefined }, 'glm-5.3-flash', 200_000)).toBeNull();
  });
});
