import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { errorDetail, errorSentence } from './index';

// A ZodError's message is its issues as pretty JSON; the first line is a bare `[`, which is what a history refresh
// failure used to toast ("Couldn't refresh the conversation [").
const zodError = () => {
  const parsed = z.object({ turns: z.array(z.object({ status: z.enum(['completed', 'failed']) })) })
    .safeParse({ turns: [{ status: 'cancelled' }] });
  if (parsed.success) throw new Error('fixture must fail');
  return parsed.error;
};

describe('errorSentence', () => {
  it('says the first issue of a structured payload, with where it is', () => {
    const sentence = errorSentence(zodError().message);
    expect(sentence.startsWith('turns.0.status: ')).toBe(true);
    expect(sentence).not.toContain('\n');
  });

  it('returns a plain sentence unchanged', () => {
    expect(errorSentence('  stream closed  ')).toBe('stream closed');
    expect(errorSentence('[path] is not a JSON payload')).toBe('[path] is not a JSON payload');
  });
});

describe('errorDetail with a structured message', () => {
  it('puts the sentence first and keeps the whole payload after it', () => {
    const error = zodError();
    const lines = errorDetail(error)!.split('\n');
    expect(lines[0]).toBe(errorSentence(error.message));
    expect(errorDetail(error)!.endsWith(error.message.trim())).toBe(true);
  });

  it('is unchanged for a one-line message', () => {
    expect(errorDetail(new Error('Internal error'))).toBe('Internal error');
  });
});
