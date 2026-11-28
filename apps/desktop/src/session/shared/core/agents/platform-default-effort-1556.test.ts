import { describe, expect, it } from 'vitest';
import { platformDefaultReasoningEffort } from './platform-model';
import { platformEffortFacts, resolveCreateEfforts, resolveInitialEffort } from './create-efforts';

// gugu-dev#1556 The directory's default level for a platform model, read as optional: absent or invalid → today's rules.
describe('platform default reasoning effort (gugu-dev#1556)', () => {
  it('is kept only when it is one of the model levels', () => {
    expect(platformDefaultReasoningEffort('medium', ['low', 'medium'])).toEqual({ defaultReasoningEffort: 'medium' });
    expect(platformDefaultReasoningEffort(' low ', ['low', 'high', 'max'])).toEqual({ defaultReasoningEffort: 'low' });
    expect(platformDefaultReasoningEffort('medium', ['low', 'high', 'max'])).toEqual({});
    expect(platformDefaultReasoningEffort('medium', null)).toEqual({});
    expect(platformDefaultReasoningEffort(undefined, ['medium'])).toEqual({});
    expect(platformDefaultReasoningEffort(3, ['medium'])).toEqual({});
  });

  it('reaches the platform facts the composers resolve levels from', () => {
    const models = [
      { id: 'glm-5.3', reasoningEfforts: ['low', 'high', 'max'], defaultReasoningEffort: 'low' },
      { id: 'gpt-6-luna', reasoningEfforts: ['low', 'medium', 'high'] },
    ];
    expect(platformEffortFacts('glm-5.3', models)).toEqual({ reasoningEfforts: ['low', 'high', 'max'], defaultReasoningEffort: 'low' });
    expect(platformEffortFacts('gpt-6-luna', models)).toEqual({ reasoningEfforts: ['low', 'medium', 'high'] });
  });

  it('becomes the new-task default and is armed before the fixed medium', () => {
    const efforts = (defaultReasoningEffort?: string) => resolveCreateEfforts({
      state: { kind: 'unsupported' },
      effortCapability: { kind: 'selectable', effortOptions: { low: { name: 'Low' }, medium: { name: 'Medium' }, high: { name: 'High' }, max: { name: 'Max' } } },
      staticModelsCapability: undefined,
      model: null,
      platformModel: { reasoningEfforts: ['low', 'high', 'max'], ...(defaultReasoningEffort ? { defaultReasoningEffort } : {}) },
      leg: 'acp',
    } as Parameters<typeof resolveCreateEfforts>[0]);
    const withDefault = efforts('low');
    expect(withDefault?.defaultId).toBe('low');
    expect(resolveInitialEffort(withDefault, undefined, withDefault?.defaultId)).toBe('low');
    // A pick or an explicit reset still wins over the directory.
    expect(resolveInitialEffort(withDefault, 'high', withDefault?.defaultId)).toBe('high');
    expect(resolveInitialEffort(withDefault, null, withDefault?.defaultId)).toBeNull();
    // No default from the directory: the model without medium starts on none, as today.
    const without = efforts();
    expect(without?.defaultId ?? null).toBeNull();
    expect(resolveInitialEffort(without, undefined, without?.defaultId)).toBeNull();
  });
});
