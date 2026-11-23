import { describe, expect, it } from 'vitest';
import { creationRecoveryDecision as decide, inspectCreationInputCustody as inspect, type CreationRecoveryFacts } from './creation-attachment-recovery';

const expected = { initialMessageId: 'message-a', placementKey: 'placement-a' };
const facts = (patch: Partial<CreationRecoveryFacts> = {}): CreationRecoveryFacts => ({ admissionProtocol: { version: 2 },
  prepared: { placementKey: expected.placementKey }, admitting: null, admitted: null, ...patch });
const claim = { initialMessageId: expected.initialMessageId, placementKey: expected.placementKey };
const input = { conversationId: 'task-a', clientMessageId: 'message-a', text: 'caption', files: [{ itemId: 'item-a', version: 1,
  name: 'one.txt', mimeType: 'text/plain', sizeBytes: 3, requiredPlacement: { chatId: 'dm-a', sha256: 'a'.repeat(64) } }] };
const row = (metadata: unknown = { kind: 'session-direct', state: 'accepted', sourceInput: { text: input.text, files: input.files } }) => ({
  id: 'message-a', sessionId: 'task-a', sender: 'user', content: 'rendered caption with file path', metadata: JSON.stringify(metadata) });

describe('creation recovery policy (not a provider or journal integration test)', () => {
  it('keeps injection-before-receipt crash unknown after reconstruction', () => {
    const durable = JSON.parse(JSON.stringify(facts({ admitting: claim }))) as CreationRecoveryFacts;
    // The fixture models a provider side effect followed by process death, without an accepted row.
    let injections = 1;
    const decision = decide(expected, durable, inspect(input, undefined));
    if (decision === 'claim-required') injections++;
    expect(decision).toBe('unknown'); expect(injections).toBe(1);
  });
  it('also keeps claim-before-send crash unknown; it cannot infer whether a side effect ran', () => {
    expect(decide(expected, facts({ admitting: claim }), 'absent')).toBe('unknown');
  });
  it('allows verification/claim after a pre-claim rejection; this is not permission to send without exclusive append', () => {
    expect(decide(expected, facts({ prepared: null }), 'absent')).toBe('verify-first');
    expect(decide(expected, facts(), 'absent')).toBe('claim-required');
  });
  it('reconciles a lost ACK from matching actual custody without requesting a second claim', () => {
    expect(decide(expected, facts({ admitting: claim }), inspect(input, row()))).toBe('confirm-custody');
  });
  it('does not retroactively send a legacy prepared record without the protocol marker', () => {
    expect(decide(expected, facts({ admissionProtocol: null }), 'absent')).toBe('unknown');
    expect(decide(expected, facts({ admissionProtocol: null }), inspect(input, row()))).toBe('confirm-custody');
  });
  it.each([
    { admissionProtocol: { version: 1 } },
    { admissionProtocol: null, admitting: claim },
    { prepared: null, admitting: claim },
  ])('refuses invalid protocol or orphaned claims even with a matching row (%j)', patch => {
    expect(decide(expected, facts(patch), 'custody')).toBe('conflict');
  });
  it('retains the exact durable admitted marker if the canonical receipt was cleaned up', () => {
    expect(decide(expected, facts({ admitted: { initialMessageId: 'message-a' } }), 'absent')).toBe('confirm-custody');
  });
  it.each([
    { prepared: { placementKey: 'other' } },
    { admitting: { ...claim, initialMessageId: 'other' } },
    { admitting: { ...claim, placementKey: 'other' } },
    { admitted: { initialMessageId: 'other' } },
  ])('refuses conflicting durable markers even if another input appears owned (%j)', patch => {
    expect(decide(expected, facts(patch), 'custody')).toBe('conflict');
  });
  it('does not reinterpret read failures as an absent receipt or a retry permit', () => {
    expect(decide(expected, facts(), 'unavailable')).toBe('unknown');
    expect(decide(expected, facts(), 'conflict')).toBe('conflict');
  });
});

describe('actual-row custody inspection (no DB/HTTP/provider substitute)', () => {
  it.each(['queued', 'dispatching', 'accepted', 'failed', 'outcome-unknown'])('treats %s as custody, not model completion', state => {
    expect(inspect(input, row({ kind: 'session-direct', state, sourceInput: { text: input.text, files: input.files } }))).toBe('custody');
  });
  it('recognizes the actual ACP queue metadata shape without inventing a delivery state', () => {
    expect(inspect(input, { ...row({ kind: 'session-direct', delivery: { files: input.files } }), content: 'caption' })).toBe('custody');
  });
  it.each([
    { ...row(), id: 'other' }, { ...row(), sender: 'agent' },
    row({ kind: 'session-direct', state: 'accepted', sourceInput: { text: 'changed', files: input.files } }),
    row({ kind: 'session-direct', state: 'accepted', sourceInput: { text: input.text, files: [{ ...input.files[0], version: 2 }] } }),
    row({ kind: 'session-direct', state: 'accepted', sourceInput: { text: input.text, files: [{ ...input.files[0], requiredPlacement: { chatId: 'other', sha256: 'a'.repeat(64) } }] } }),
    row({ kind: 'session-direct', state: 'accepted', sourceInput: { text: input.text, files: [{ ...input.files[0], requiredPlacement: { chatId: 'dm-a', sha256: 'b'.repeat(64) } }] } }),
  ])('refuses identity/body/file/DM/digest drift (%j)', actual => { expect(inspect(input, actual)).toBe('conflict'); });
  it('keeps malformed or unknown metadata unverified', () => {
    expect(inspect(input, { ...row(), metadata: '{' })).toBe('unavailable');
    expect(inspect(input, row({ kind: 'session-direct', state: 'new-unrecognized-state' }))).toBe('unavailable');
    expect(inspect(input, row({ kind: 'session-direct', sourceInput: null }))).toBe('unavailable');
    expect(inspect(input, row({ kind: 'session-direct', state: ['accepted'], sourceInput: { text: input.text, files: input.files } }))).toBe('unavailable');
  });
});
