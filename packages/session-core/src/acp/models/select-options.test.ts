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

  it('treats non-array wire values as empty options', () => {
    for (const malformed of [null, {}, 'not an array', 1]) {
      expect(flattenSelectOptions(malformed as unknown as SessionConfigSelectOptions)).toEqual([]);
    }
  });

  it('skips groups whose options are missing or are not arrays', () => {
    const malformed = [
      { group: 'missing', name: 'Missing' },
      { group: 'null', name: 'Null', options: null },
      { group: 'object', name: 'Object', options: {} },
    ];
    expect(flattenSelectOptions(malformed as unknown as SessionConfigSelectOptions)).toEqual([]);
  });

  it('skips null and primitive entries, including inside groups', () => {
    const valid = { value: 'own', name: 'Own model' };
    const malformed = [null, 'text', 1, [], {
      group: 'provider', name: 'Provider', options: [null, 'text', 1, [], valid],
    }];
    expect(flattenSelectOptions(malformed as unknown as SessionConfigSelectOptions)).toEqual([valid]);
  });
});
