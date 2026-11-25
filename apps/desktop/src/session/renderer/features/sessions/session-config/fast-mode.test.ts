import { describe, expect, it } from 'vitest';
import { draftFastMode, sessionFastMode } from './fast-mode';

describe('platform Fast in the model details card', () => {
  const draft = {
    platformModel: 'gpt-6-luna', modelId: null, catalog: { kind: 'unavailable' }, capabilities: null,
  };
  const live = { route: 'platform' as const, capabilities: null, group: null };

  it('shows the draft switch only when the selected route advertises Fast', () => {
    expect(draftFastMode({ ...draft, enabled: true, platformSupported: true })).toBe(true);
    expect(draftFastMode({ ...draft, enabled: false, platformSupported: true })).toBe(false);
    expect(draftFastMode({ ...draft, enabled: true })).toBeUndefined();
  });

  it('uses the persisted platform choice on reopen rather than requiring a native Fast option', () => {
    expect(sessionFastMode({ ...live, recorded: true, platformSupported: true })).toBe(true);
    expect(sessionFastMode({ ...live, recorded: false, platformSupported: true })).toBe(false);
    expect(sessionFastMode({ ...live, recorded: true })).toBeUndefined();
  });
});
