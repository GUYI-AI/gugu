import { expect, it } from 'vitest';
import { autoReviewModelOptions, autoReviewModelSchema } from './auto-review-model';
import type { CustomModelConnection } from './custom-model';

const connection = (id: string, patch: Partial<CustomModelConnection> = {}): CustomModelConnection => ({
  id, name: id, preset: null, credentialRef: 'test-secret-reference', keySaved: true,
  endpoints: [{ protocol: 'anthropic-messages', baseUrl: 'https://example.test' }], models: [{ id: 'same-model' }], ...patch,
});
it('keeps the provider identity when two compatible connections expose the same model', () => {
  const options = autoReviewModelOptions([connection('one'), connection('two')]);
  expect(options.map(({ connectionId, modelId }) => [connectionId, modelId])).toEqual([['one', 'same-model'], ['two', 'same-model']]);
});
it('does not authorize removed, keyless or incompatible connections as auxiliary reviewers', () => {
  expect(autoReviewModelOptions([
    connection('removed', { removed: true }), connection('missing-key', { keySaved: false }),
    connection('openai-only', { endpoints: [{ protocol: 'openai-responses', baseUrl: 'https://example.test' }] }),
    connection('no-model', { models: [] }), connection('valid'),
  ]).map(({ connectionId }) => connectionId)).toEqual(['valid']);
});
it('stores a complete custom model identity or the explicit default', () => {
  expect(autoReviewModelSchema.parse(null)).toBeNull();
  expect(autoReviewModelSchema.safeParse({ kind: 'custom', connectionId: '481825a8-60b9-4c83-8d1b-f104e3db0269', modelId: '' }).success).toBe(false);
  expect(autoReviewModelSchema.parse({ kind: 'custom', connectionId: '481825a8-60b9-4c83-8d1b-f104e3db0269', modelId: 'upstream/model-v1' })).toMatchObject({ modelId: 'upstream/model-v1' });
});
