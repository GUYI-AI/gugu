import { createHash } from 'node:crypto';
import type { WindowRecordEnvelope } from './window-cache/types';

type Value = { canonicalId: string; revision: string; projectionRef: string };
type Lookup = { kind: 'found'; value: Value } | { kind: 'absent' };
type Write = { scope: string; lineage: string; key: string; value: Value };
/** Bodies and snapshot revisions are unused; the shared schema remains owned by A. */
export type SourceIdentityEnvelope = WindowRecordEnvelope;
export type IdentityContext = {
  sourceScope: string; sourceLineage: string; conversationScope: string; branchLineage: string;
  atCommit: number; canonicalId?: string; ancestryComplete: boolean;
  /** Exact per-record membership proofs from the branch/range index, never a whole ancestry list. */
  inherited?: readonly { branchLineage: string; atCommit: number; nativeKey: string; revision: string }[];
  ownerParentProof?: { nativeId: string; branchLineage: string; atCommit: number };
};
export type IdentityQueries = {
  receipt(key: string): Promise<Lookup>;
  identity(branch: string, nativeKey: string, atCommit: number): Promise<Lookup>;
};
export type IdentityPlan =
  | { kind: 'unlocated' }
  | { kind: 'dependency'; nativeKey: string; reason: 'ancestry_unknown' | 'inherited_revision_missing' | 'ownership_unknown' }
  | { kind: 'apply' | 'update' | 'duplicate'; value: Value; nativeKey: string; receiptKey: string;
      receipts: readonly Write[]; aliases: readonly Write[]; previous?: Value };

export class SourceIdentityError extends Error {
  constructor(readonly code: 'invalid_anchor' | 'identity_conflict', detail: string) {
    super(`Source identity ${code}: ${detail}`); this.name = 'SourceIdentityError';
  }
}
function scalar(value: unknown, optional = false): string | null {
  if (value == null && optional) return null;
  if (typeof value !== 'string' || !value.length || value.length > 256) throw new SourceIdentityError('invalid_anchor', 'bounded metadata scalar required');
  return value;
}
function integer(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new SourceIdentityError('invalid_anchor', 'unsafe byte offset, fragment or fence');
}
function hash(parts: readonly (string | number)[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}
function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** Select bounded identity metadata only. In particular, never inspect message content/tool output. */
export function windowRecordMetadata(provider: 'claude' | 'codex', record: Record<string, unknown>): Record<string, unknown> {
  const payload = object(record.payload), metadata = object(payload?.metadata), message = object(record.message);
  return provider === 'claude'
    ? { uuid: scalar(record.uuid, true), parentUuid: scalar(record.parentUuid, true), messageId: scalar(message?.id, true),
        role: scalar(message?.role, true), recordType: scalar(record.type, true), callParentUuid: scalar(record.sourceToolAssistantUUID, true) }
    : { taskId: scalar(payload?.turn_id ?? metadata?.turn_id, true), callId: scalar(payload?.call_id, true),
        recordType: scalar(record.type, true), itemType: scalar(payload?.type, true), role: scalar(payload?.role, true) };
}

/** Versioned semantic keys retain Claude record UUID semantics; Codex item IDs can be renumbered on resume. */
export function sourceEventKeys(input: SourceIdentityEnvelope, context: IdentityContext): { receiptKey: string; nativeKey: string } | null {
  if (input.recordStart === null) return null;
  integer(input.recordStart); integer(input.fragment); integer(context.atCommit);
  [context.sourceScope, context.sourceLineage, context.conversationScope, context.branchLineage, input.eventKind, input.revision, input.projectionRef].forEach(value => scalar(value));
  if (input.provider !== 'claude' && input.provider !== 'codex') throw new SourceIdentityError('invalid_anchor', 'provider');
  const uuid = input.provider === 'claude' ? scalar(input.recordMetadata.uuid, true) : null;
  const anchor = uuid ? ['uuid', uuid] : ['byte', context.sourceLineage, input.recordStart];
  return {
    nativeKey: `${input.provider}/2/${hash([...anchor, input.fragment, input.eventKind])}`,
    receiptKey: `input/2/${hash([context.sourceLineage, input.recordStart, input.fragment, input.eventKind, input.revision])}`,
  };
}

/** Return a plan for only this fragment. The caller commits it with A's original bounded segment. */
export async function planSourceIdentity(input: SourceIdentityEnvelope, context: IdentityContext, queries: IdentityQueries): Promise<IdentityPlan> {
  const keys = sourceEventKeys(input, context);
  if (!keys) return { kind: 'unlocated' };
  if ((context.inherited?.length ?? 0) > 8) throw new SourceIdentityError('invalid_anchor', 'too many point proofs');
  const supplied = scalar(context.canonicalId, true);
  function compatible(value: Value): void {
    if (supplied && supplied !== value.canonicalId) throw new SourceIdentityError('identity_conflict', 'canonical alias differs');
  }
  const receipt = await queries.receipt(keys.receiptKey);
  if (receipt.kind === 'found') {
    compatible(receipt.value);
    if (receipt.value.revision !== input.revision) throw new SourceIdentityError('identity_conflict', 'input receipt revision differs');
    return { kind: 'duplicate', ...keys, value: receipt.value, receipts: [], aliases: [] };
  }
  const own = await queries.identity(context.branchLineage, keys.nativeKey, context.atCommit);
  let previous = own.kind === 'found' ? own.value : undefined;
  if (!previous && input.provider === 'claude' && scalar(input.recordMetadata.uuid, true)) {
    if (!context.ancestryComplete) return { kind: 'dependency', nativeKey: keys.nativeKey, reason: 'ancestry_unknown' };
    for (const proof of context.inherited ?? []) {
      scalar(proof.branchLineage); scalar(proof.nativeKey); scalar(proof.revision); integer(proof.atCommit);
      if (proof.nativeKey !== keys.nativeKey) continue;
      if (proof.revision !== input.revision) return { kind: 'dependency', nativeKey: keys.nativeKey, reason: 'inherited_revision_missing' };
      const parent = await queries.identity(proof.branchLineage, keys.nativeKey, proof.atCommit);
      if (parent.kind === 'absent' || parent.value.revision !== proof.revision) {
        return { kind: 'dependency', nativeKey: keys.nativeKey, reason: 'inherited_revision_missing' };
      }
      if (previous && previous.canonicalId !== parent.value.canonicalId) throw new SourceIdentityError('identity_conflict', 'inherited aliases disagree');
      previous = parent.value;
    }
  }
  if (previous) compatible(previous);
  if (!previous && !supplied) return { kind: 'dependency', nativeKey: keys.nativeKey, reason: 'ownership_unknown' };
  const value: Value = { canonicalId: (previous?.canonicalId ?? supplied)!,
    revision: input.revision, projectionRef: input.projectionRef };
  const same = previous?.revision === input.revision;
  return { kind: same ? 'duplicate' : previous ? 'update' : 'apply', ...keys, value,
    receipts: [{ scope: context.sourceScope, lineage: context.sourceLineage, key: keys.receiptKey, value }],
    aliases: own.kind === 'found' && same ? [] : [{ scope: context.conversationScope, lineage: context.branchLineage, key: keys.nativeKey, value }],
    ...(previous ? { previous } : {}) };
}

/** Explicit references for a window whose call/task lies before the selected source range. */
export function sourceDependencies(input: SourceIdentityEnvelope): readonly { kind: 'task' | 'call' | 'record'; nativeId: string }[] {
  const metadata = input.recordMetadata;
  const task = scalar(metadata.taskId, true), call = scalar(metadata.callId, true), parent = scalar(metadata.callParentUuid, true);
  return [...(task ? [{ kind: 'task' as const, nativeId: task }] : []),
    ...(call ? [{ kind: 'call' as const, nativeId: call }] : []), ...(parent ? [{ kind: 'record' as const, nativeId: parent }] : [])];
}

export type CanonicalOwner = { turnId: string; itemId: string | null };
/** Unresolved display rows keep this key when ownership is later attached; it is never a canonical turn ID. */
export function sourceFragmentKey(input: SourceIdentityEnvelope, context: IdentityContext): string | null {
  const keys = sourceEventKeys(input, context);
  if (!keys) return null;
  if (input.provider === 'claude' && scalar(input.recordMetadata.uuid, true)) {
    return `fragment:v1:${hash([context.conversationScope, context.branchLineage, keys.nativeKey])}`;
  }
  return `fragment:v1:${hash([context.sourceLineage, input.recordStart!, input.fragment, input.eventKind])}`;
}
export function sourceOwnershipKey(provider: 'claude' | 'codex', kind: 'record' | 'task' | 'call', nativeId: string): string {
  scalar(nativeId); return `owner/1/${provider}/${hash([kind, nativeId])}`;
}
/** Native aliases are written with real capture/import ownership; absence never authorizes window-relative IDs. */
export async function resolveCanonicalOwner(input: SourceIdentityEnvelope, context: IdentityContext,
  lookup: (branch: string, key: string, atCommit: number) => Promise<CanonicalOwner | null>
): Promise<{ kind: 'found'; owner: CanonicalOwner } | { kind: 'unlocated' } | { kind: 'dependency'; keys: readonly string[] }> {
  if (!sourceEventKeys(input, context)) return { kind: 'unlocated' };
  const metadata = input.recordMetadata, uuid = input.provider === 'claude' ? scalar(metadata.uuid, true) : null;
  const refs = [...(uuid ? [{ kind: 'record' as const, nativeId: uuid }] : []),
    ...sourceDependencies(input).filter(ref => ref.kind !== 'record')];
  const keys = refs.map(ref => sourceOwnershipKey(input.provider, ref.kind, ref.nativeId));
  let knownTurn: string | null = null, knownItem: string | null = null;
  for (let index = 0; index < keys.length; index++) {
    const owner = await lookup(context.branchLineage, keys[index], context.atCommit);
    if (!owner) continue;
    scalar(owner.turnId); scalar(owner.itemId, true);
    const itemId = refs[index].kind === 'task' ? null : owner.itemId;
    if (knownTurn && (knownTurn !== owner.turnId || (knownItem && itemId && knownItem !== itemId))) {
      throw new SourceIdentityError('identity_conflict', 'native ownership aliases disagree');
    }
    knownTurn = owner.turnId;
    if (itemId !== null) knownItem = itemId;
  }
  if (knownTurn) return { kind: 'found', owner: { turnId: knownTurn, itemId: knownItem } };
  const proof = context.ownerParentProof;
  if (proof) {
    scalar(proof.nativeId); scalar(proof.branchLineage); integer(proof.atCommit);
    if (input.provider !== 'claude' || ![metadata.parentUuid, metadata.callParentUuid].includes(proof.nativeId)) {
      throw new SourceIdentityError('invalid_anchor', 'parent ownership proof does not bind this record');
    }
    const key = sourceOwnershipKey('claude', 'record', proof.nativeId);
    const owner = await lookup(proof.branchLineage, key, proof.atCommit);
    if (owner) { scalar(owner.turnId); return { kind: 'found', owner: { turnId: owner.turnId, itemId: null } }; }
    keys.push(key);
  }
  return { kind: 'dependency', keys };
}
