import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { planSourceIdentity, resolveCanonicalOwner, sourceDependencies, sourceEventKeys, sourceFragmentKey, sourceOwnershipKey, windowRecordMetadata,
  type IdentityContext, type IdentityQueries, type SourceIdentityEnvelope } from './tail-source-identity';

const context = (): IdentityContext => ({ sourceScope: 'source', sourceLineage: 'lineage', conversationScope: 'conversation',
  branchLineage: 'root', atCommit: 3, ancestryComplete: true, canonicalId: 'stored:turn:s9' });
const envelope = (provider: 'claude' | 'codex' = 'claude'): SourceIdentityEnvelope => ({ provider, recordStart: 2 ** 33,
  sourceRange: { start: 2 ** 33, end: 2 ** 33 + 100 }, fragment: 0, eventKind: 'message', revision: 'v1', projectionRef: 'projection:1', recordMetadata: { uuid: 'record-uuid', messageId: 'message-id' } });
const absent = { kind: 'absent' as const };
const value = { canonicalId: 'stored:turn:s9', revision: 'v1', projectionRef: 'old' };
const queries = (): IdentityQueries => ({ receipt: vi.fn(async () => absent), identity: vi.fn(async () => absent) });

describe('tail source identities', () => {
  it('is append/window stable without reading a prefix or a snapshot revision', async () => {
    const a = await planSourceIdentity(envelope('codex'), context(), queries());
    const b = await planSourceIdentity({ ...envelope('codex'), recordMetadata: { id: 'renumbered-on-resume' } }, context(), queries());
    expect(a).toEqual(b); expect(a.kind).toBe('apply');
    expect(sourceEventKeys({ ...envelope('codex'), recordStart: 2 ** 33 + 100 }, context())?.nativeKey).not.toBe(a.kind === 'apply' ? a.nativeKey : '');
  });
  it('uses Claude record UUID rather than a shared assistant message ID', async () => {
    const lines = (await readFile(new URL('./__fixtures__/claude-session.jsonl', import.meta.url), 'utf8')).trim().split('\n');
    const records = lines.slice(2, 4).map(line => windowRecordMetadata('claude', JSON.parse(line)));
    expect(records[0].messageId).toBe(records[1].messageId);
    expect(sourceEventKeys({ ...envelope(), recordMetadata: records[0] }, context())?.nativeKey)
      .not.toBe(sourceEventKeys({ ...envelope(), recordMetadata: records[1] }, context())?.nativeKey);
    expect(sourceEventKeys({ ...envelope(), recordStart: 99 }, context())?.nativeKey).toBe(sourceEventKeys(envelope(), context())?.nativeKey);
  });
  it('treats a physical receipt independently from semantic revisions', async () => {
    const q = queries(); q.receipt = vi.fn(async () => ({ kind: 'found' as const, value }));
    const duplicate = await planSourceIdentity(envelope(), context(), q);
    expect(duplicate.kind).toBe('duplicate'); expect(q.identity).not.toHaveBeenCalled();
    const next = { ...envelope(), revision: 'v2' };
    expect(sourceEventKeys(next, context())?.receiptKey).not.toBe(sourceEventKeys(envelope(), context())?.receiptKey);
    q.receipt = async () => absent; q.identity = async () => ({ kind: 'found', value });
    const revision = await planSourceIdentity(next, context(), q);
    expect(revision).toMatchObject({ kind: 'update', value: { canonicalId: value.canonicalId, revision: 'v2' } });
  });
  it('preserves canonical aliases and rejects conflicting supplied identities', async () => {
    expect(await planSourceIdentity(envelope(), { ...context(), canonicalId: value.canonicalId }, queries()))
      .toMatchObject({ kind: 'apply', value: { canonicalId: value.canonicalId } });
    const q = queries(); q.identity = async () => ({ kind: 'found', value });
    await expect(planSourceIdentity(envelope(), { ...context(), canonicalId: 'wrong' }, q)).rejects.toMatchObject({ code: 'identity_conflict' });
  });
  it('resolves copied ancestry only by an exact record proof at the parent commit', async () => {
    const ctx = { ...context(), branchLineage: 'fork', inherited: [{ branchLineage: 'root', atCommit: 2,
      nativeKey: sourceEventKeys(envelope(), context())!.nativeKey, revision: 'v1' }] };
    const q = queries(); q.identity = vi.fn(async (branch: string) => branch === 'root' ? { kind: 'found' as const, value } : absent);
    const plan = await planSourceIdentity(envelope(), ctx, q);
    expect(plan).toMatchObject({ kind: 'duplicate', value: { canonicalId: value.canonicalId }, aliases: [{ lineage: 'fork' }] });
    expect(q.identity).toHaveBeenCalledWith('root', ctx.inherited[0].nativeKey, 2);
    const diverged = await planSourceIdentity(envelope(), { ...context(), canonicalId: undefined, branchLineage: 'other-fork' }, queries());
    expect(diverged).not.toMatchObject({ value: { canonicalId: value.canonicalId } });
  });
  it('keeps incomplete ancestry and missing inherited revisions explicit', async () => {
    const q = queries();
    expect(await planSourceIdentity(envelope(), { ...context(), ancestryComplete: false }, q)).toMatchObject({ kind: 'dependency', reason: 'ancestry_unknown' });
    const inherited = [{ branchLineage: 'parent', atCommit: 1, nativeKey: sourceEventKeys(envelope(), context())!.nativeKey, revision: 'v1' }];
    expect(await planSourceIdentity(envelope(), { ...context(), inherited }, q)).toMatchObject({ kind: 'dependency', reason: 'inherited_revision_missing' });
    await expect(planSourceIdentity(envelope(), { ...context(), inherited: Array(9).fill(inherited[0]) }, q)).rejects.toMatchObject({ code: 'invalid_anchor' });
  });
  it('never assigns an identity to an unlocated long-record ticket', async () => {
    const q = queries();
    expect(await planSourceIdentity({ ...envelope(), recordStart: null }, context(), q)).toEqual({ kind: 'unlocated' });
    expect(q.receipt).not.toHaveBeenCalled(); expect(q.identity).not.toHaveBeenCalled();
    await expect(planSourceIdentity({ ...envelope(), recordStart: Number.MAX_SAFE_INTEGER + 1 }, context(), q)).rejects.toMatchObject({ code: 'invalid_anchor' });
  });
  it('selects real native task/call references without touching giant bodies', async () => {
    const record = { type: 'response_item', payload: { type: 'function_call_output', call_id: 'call-native',
      metadata: { turn_id: 'task-native' }, get output(): never { throw new Error('body read'); } } };
    const metadata = windowRecordMetadata('codex', record);
    expect(sourceDependencies({ ...envelope('codex'), recordMetadata: metadata })).toEqual([
      { kind: 'task', nativeId: 'task-native' }, { kind: 'call', nativeId: 'call-native' }]);
    const q = queries(); q.receipt = async () => { throw new Error('index_budget'); };
    await expect(planSourceIdentity(envelope(), context(), q)).rejects.toThrow('index_budget');
  });
  it('resolves canonical turn/item aliases and leaves unknown ownership explicit', async () => {
    const owner = { turnId: 'canonical:turn:s7', itemId: 'canonical:turn:s7:message:9' };
    const lookup = vi.fn(async () => owner);
    expect(await resolveCanonicalOwner(envelope(), context(), lookup)).toEqual({ kind: 'found', owner });
    expect(lookup).toHaveBeenCalledWith('root', sourceOwnershipKey('claude', 'record', 'record-uuid'), 3);
    expect(await resolveCanonicalOwner(envelope(), context(), async () => null)).toMatchObject({ kind: 'dependency' });
    expect(await planSourceIdentity(envelope(), { ...context(), canonicalId: undefined }, queries())).toMatchObject({ kind: 'dependency', reason: 'ownership_unknown' });
    expect(await resolveCanonicalOwner({ ...envelope(), recordStart: null }, context(), lookup)).toEqual({ kind: 'unlocated' });
    const key = sourceFragmentKey(envelope(), context());
    expect(sourceFragmentKey({ ...envelope(), revision: 'new-revision' }, context())).toBe(key);
    expect(sourceFragmentKey({ ...envelope(), recordStart: 9 }, { ...context(), sourceLineage: 'continuation-file' })).toBe(key);
    const proof = { nativeId: 'parent-record', branchLineage: 'parent', atCommit: 1 };
    const child = { ...envelope(), recordMetadata: { ...envelope().recordMetadata, parentUuid: proof.nativeId } };
    expect(await resolveCanonicalOwner(child, { ...context(), ownerParentProof: proof }, async branch => branch === 'parent' ? owner : null)).toEqual({ kind: 'found', owner: { turnId: owner.turnId, itemId: null } });
    await expect(resolveCanonicalOwner(envelope(), { ...context(), ownerParentProof: proof }, async () => null)).rejects.toMatchObject({ code: 'invalid_anchor' });
  });
  it('resolves a real call item beyond a task-only turn alias and rejects conflicting turns', async () => {
    const input = { ...envelope('codex'), recordMetadata: { taskId: 'task', callId: 'call' } };
    const callKey = sourceOwnershipKey('codex', 'call', 'call');
    const owner = { turnId: 'real:turn', itemId: 'real:tool:call' };
    expect(await resolveCanonicalOwner(input, context(), async (_branch, key) => key === callKey ? owner : { turnId: owner.turnId, itemId: null }))
      .toEqual({ kind: 'found', owner });
    await expect(resolveCanonicalOwner(input, context(), async (_branch, key) => key === callKey ? owner : { turnId: 'wrong:turn', itemId: null }))
      .rejects.toMatchObject({ code: 'identity_conflict' });
  });
});
