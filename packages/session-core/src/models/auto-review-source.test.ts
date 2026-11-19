import { describe, expect, it } from 'vitest';
import { customClaudeReviewSource, DEFAULT_CLAUDE_REVIEWER, nativeClaudeReviewEnv } from './auto-review-source';
const connectionId = '00000000-0000-4000-8000-000000000001';
const model = { id: 'proxy/reviewer-v1' };
const input = { connectionId, endpoint: 'https://compatible.example/v1', selectedModel: 'claude-sonnet-5', models: [model], preference: null };
describe('start-time reviewer source', () => {
  it('keeps compatible requests on the selected main model by default', () => {
    expect(customClaudeReviewSource(input)).toEqual({ kind: 'own', modelId: 'claude-sonnet-5' });
  });
  it('defaults an official Anthropic key to Haiku', () => {
    expect(customClaudeReviewSource({ ...input, endpoint: 'https://api.anthropic.com' })).toEqual({ kind: 'own', modelId: DEFAULT_CLAUDE_REVIEWER });
  });
  it('accepts the explicit reviewer only on its original, still-listed connection', () => {
    const preference = { kind: 'custom' as const, connectionId, modelId: model.id };
    expect(customClaudeReviewSource({ ...input, preference })).toEqual({ kind: 'own', modelId: model.id });
    expect(customClaudeReviewSource({ ...input, preference, endpoint: 'https://api.anthropic.com' })).toEqual({ kind: 'own', modelId: model.id });
    for (const changed of [{ models: [] }, { removed: true }, { connectionId: 'other' }]) {
      expect(customClaudeReviewSource({ ...input, preference, ...changed })).toEqual({ kind: 'own', modelId: 'claude-sonnet-5' });
    }
  });
  it('reserves an unconnected fallback only when a compatible connection has no known main model', () => {
    expect(customClaudeReviewSource({ ...input, selectedModel: ' ' })).toEqual({ kind: 'platform-fallback' });
  });
  it('does not identify lookalike hosts as the official Anthropic service', () => {
    expect(customClaudeReviewSource({ ...input, endpoint: 'https://api.anthropic.com.example' })).toEqual({ kind: 'own', modelId: input.selectedModel });
  });
  it.each([{}, { CLAUDE_CODE_OAUTH_TOKEN: 'fixture' }, { ANTHROPIC_AUTH_TOKEN: 'fixture' }, { ANTHROPIC_API_KEY: 'fixture', ANTHROPIC_BASE_URL: 'https://compatible.example' }])('leaves native subscription/unknown providers on their classifier: %j', env => {
    expect(nativeClaudeReviewEnv(env)).toEqual({});
  });
  it('pins Haiku for the official native API key without carrying the key into the result', () => {
    expect(nativeClaudeReviewEnv({ ANTHROPIC_API_KEY: 'fixture' })).toEqual({ CLAUDE_CODE_AUTO_MODE_MODEL: DEFAULT_CLAUDE_REVIEWER, CLAUDE_CODE_AUTO_MODE_SERVER: '0' });
  });
});

it.each(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'])('uses an explicitly selected model on a native compatible API (%s)', credential => {
  expect(nativeClaudeReviewEnv({ [credential]: 'fixture', ANTHROPIC_BASE_URL: 'https://compatible.example/v1', ANTHROPIC_MODEL: 'claude-sonnet-5' }))
    .toEqual({ CLAUDE_CODE_AUTO_MODE_MODEL: 'claude-sonnet-5', CLAUDE_CODE_AUTO_MODE_SERVER: '0' });
});

it('uses a listed same-connection Haiku when the main model cannot classify', () => {
  const source = { ...input, selectedModel: 'claude-opus-5', models: [{ id: 'claude-opus-5' }, { id: 'claude-haiku-5-5' }] };
  expect(customClaudeReviewSource(source)).toEqual({ kind: 'own', modelId: 'claude-haiku-5-5', byHaiku: true });
  expect(customClaudeReviewSource({ ...source, models: [{ id: 'claude-opus-5' }] })).toEqual({ kind: 'platform-fallback' });
  expect(customClaudeReviewSource({ ...source, preference: { kind: 'custom', connectionId, modelId: 'claude-opus-5' } })).toEqual({ kind: 'own', modelId: 'claude-haiku-5-5', byHaiku: true });
});
