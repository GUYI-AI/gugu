import { describe, expect, it } from 'vitest';
import * as helpers from '@gugu/session-core/agents/plugins/helpers';
import { buildPromptInjectionPayload } from './prompt-injection';

describe('TUI prompt injection', () => {
  it('encodes multiline text only from the harness declaration', () => {
    expect(buildPromptInjectionPayload({ text: 'a\nb' })).toBe('\x1b[200~a\nb\x1b[201~');
    expect(buildPromptInjectionPayload({ text: 'a\nb', multilineEncoding: 'plain' })).toBe('a\nb');
    expect(buildPromptInjectionPayload({ text: 'one line' })).toBe('one line');
    expect(buildPromptInjectionPayload({ text: 'a', forceBracketedPaste: true })).toBe('\x1b[200~a\x1b[201~');
  });

  it('has no provider-id parameter and no second copy in session-core', () => {
    // A name-keyed rule (`providerId !== 'claude'`) beside the declaration was the second source of truth.
    expect(buildPromptInjectionPayload({ providerId: 'claude', text: 'a\nb' } as never)).toBe('\x1b[200~a\nb\x1b[201~');
    expect('buildPromptInjectionPayload' in helpers).toBe(false);
  });
});
