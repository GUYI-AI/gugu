import { expect, it } from 'vitest';
import { messageReferenceId } from './message-reference';

it('keeps a globally stable client entity addressable before and after storage', () => {
  expect(messageReferenceId({ id: 'session:turn:0', referenceId: 'source:cycle' }, 'client-owned')).toBe('client-owned');
  expect(messageReferenceId({ id: 'session:turn:s0', referenceId: 'source:cycle' }, 'client-owned')).toBe('client-owned');
});

it('retains reference-prefix mapping and refuses old numeric runtime identities', () => {
  expect(messageReferenceId({ id: 'session:turn:0', referenceId: 'source:cycle' }, 'session:turn:0:message:native'))
    .toBe('source:cycle:message:native');
  expect(messageReferenceId({ id: 'session:turn:0' }, 'session:turn:0:message:local')).toBeNull();
});
