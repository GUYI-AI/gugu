import { expect, it } from 'vitest';
import { autoReviewModelOptions, autoReviewModelSchema, canSpecifyClaudeReviewModel } from './auto-review-model';
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

it.each(['claude-opus-5', 'claude-opus-5[1m]',
  'claude-opus-5-20261001', 'us.anthropic.claude-sonnet-5-5-v1:0', 'claude-opus-5-5@20261001'])('excludes native-rejected reviewer ID %s', id => {
  expect(canSpecifyClaudeReviewModel(id)).toBe(false);
});
it('filters by original ID rather than a presentation label', () => {
  const candidates = autoReviewModelOptions([connection('one', { models: [
    { id: 'claude-opus-5', label: 'A cheap model' }, { id: 'claude-haiku-5-5', label: 'Opus 5' },
    { id: 'claude-sonnet-5' }, { id: 'claude-opus-5-1' },
  ] })]);
  expect(candidates.map(model => model.modelId)).toEqual(['claude-haiku-5-5', 'claude-sonnet-5', 'claude-opus-5-1']);
});
