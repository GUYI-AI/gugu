import { describe, expect, it } from 'vitest';
import { upstreamRejectedThinking } from './upstream-said';

const error = { error: { code: 'unsupported_value', param: 'reasoning.effort', message: 'This model rejects medium' } };

describe('upstream reasoning rejection', () => {
  it('reads a structured parameter refusal and a Codex HTTP error envelope', () => {
    expect(upstreamRejectedThinking('Internal error', error)).toBe(true);
    expect(upstreamRejectedThinking(`Internal error: unexpected status 400 Bad Request: ${JSON.stringify(error)}, url: https://example.test`)).toBe(true);
    expect(upstreamRejectedThinking('Internal error', { code: 'unsupported_reasoning_effort' })).toBe(true);
  });

  it('ignores a different parameter, account errors, and unstructured text', () => {
    expect(upstreamRejectedThinking('Internal error', { error: { ...error.error, param: 'model' } })).toBe(false);
    expect(upstreamRejectedThinking('Internal error', { error: { ...error.error, code: 'invalid_api_key' } })).toBe(false);
    expect(upstreamRejectedThinking('The model may not support reasoning_effort')).toBe(false);
  });
});
