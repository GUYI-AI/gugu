import { describe, expect, it } from 'vitest';
import type { SessionConfigSelectOptions } from '@agentclientprotocol/sdk';
import { flattenSelectOptions } from './select-options';

describe('flattenSelectOptions', () => {
  it('preserves flat option values, labels and metadata', () => {
    const options = [
      { value: 'first', name: 'First', description: null, _meta: { vendor: true } },
      { value: 'second', name: 'Second', description: 'Another model' },
    ] satisfies SessionConfigSelectOptions;
    expect(flattenSelectOptions(options)).toEqual(options);
  });

  it('flattens SDK groups in order without rewriting opaque model IDs', () => {
    const first = { value: '["deepseek-official","deepseek-flash"]', name: 'DeepSeek-V4.1-Flash' };
    const second = { value: '["deepseek-official","deepseek-v4-pro"]', name: 'DeepSeek-V4-Pro' };
    const options = [
      { group: 'unused', name: 'Empty', options: [] },
      { group: 'official', name: 'Official', options: [first] },
      { group: 'other', name: 'Other', options: [second] },
    ] satisfies SessionConfigSelectOptions;
    expect(flattenSelectOptions(options)).toEqual([first, second]);
    expect(options[1].options).toEqual([first]);
  });

  it('has no choices when the select is absent or empty', () => {
    expect(flattenSelectOptions()).toEqual([]);
    expect(flattenSelectOptions([])).toEqual([]);
  });
});
