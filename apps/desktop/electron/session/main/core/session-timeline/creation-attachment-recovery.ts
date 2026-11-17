import { isDeepStrictEqual } from 'node:util';
import type { InputAdmissionPayload } from './input-admission';

type StoredInput = { id: string; sessionId: string; sender: string; content: string; metadata: string | null };
export type CreationCustodyEvidence = 'absent' | 'custody' | 'conflict' | 'unavailable';

/** Call only with an actual local DB row. A renderer reply or provider message id is not this evidence.
 * Custody includes queued/failed/unknown execution: it proves ownership, never successful execution.
 * Owner/device/request/DM/manifest scope must already be checked against the host journal.
 */
export function inspectCreationInputCustody(expected: InputAdmissionPayload, row: StoredInput | undefined): CreationCustodyEvidence {
  if (!expected.clientMessageId?.trim()) return 'conflict';
  if (row === undefined) return 'absent';
  if (row.id !== expected.clientMessageId || row.sessionId !== expected.conversationId || row.sender !== 'user') return 'conflict';
  let metadata: unknown;
  try { metadata = row.metadata ? JSON.parse(row.metadata) : null; } catch { return 'unavailable'; }
  if (!metadata || typeof metadata !== 'object') return 'unavailable';
  const value = metadata as Record<string, unknown>;
  if (value.kind !== 'ordinary-message' && value.kind !== 'session-direct') return 'conflict';
  // ACP pending rows have no state in message metadata; their body is committed with the queue row.
  if (value.state !== undefined && (typeof value.state !== 'string'
    || !['queued', 'dispatching', 'accepted', 'failed', 'outcome-unknown'].includes(value.state))) return 'unavailable';
  const delivery = value.delivery && typeof value.delivery === 'object' ? value.delivery as Record<string, unknown> : {};
  const original = value.sourceInput === undefined
    ? { text: row.content, files: delivery.files, attachments: delivery.attachments }
    : value.sourceInput;
  if (!original || typeof original !== 'object') return 'unavailable';
  const source = original as Record<string, unknown>;
  if (typeof source.text !== 'string') return 'unavailable';
  return source.text.trim() === expected.text.trim()
    && isDeepStrictEqual(source.files ?? [], expected.files ?? [])
    && isDeepStrictEqual(source.attachments ?? [], expected.attachments ?? [])
    && delivery.steerIfBusy === expected.steerIfBusy ? 'custody' : 'conflict';
}

export type CreationRecoveryFacts = {
  admissionProtocol: { version: number } | null;
  prepared: { placementKey: string } | null;
  admitting: { initialMessageId: string; placementKey: string } | null;
  admitted: { initialMessageId: string } | null;
};
export type CreationRecoveryDecision = 'verify-first' | 'claim-required' | 'confirm-custody' | 'unknown' | 'conflict';

/** Pure policy, not a send permit. `claim-required` still requires a successful exclusive durable append.
 * A pre-claim rejection can verify/claim again. Once a claim exists, absence of a receipt is UNKNOWN.
 * No marker is deleted, no TTL invents a retry, and legacy prepared never gets a retroactive permit.
 */
export function creationRecoveryDecision(
  expected: { initialMessageId: string; placementKey: string }, facts: CreationRecoveryFacts, evidence: CreationCustodyEvidence,
): CreationRecoveryDecision {
  if (!expected.initialMessageId.trim() || !expected.placementKey) return 'conflict';
  if (facts.admissionProtocol !== null && facts.admissionProtocol.version !== 2) return 'conflict';
  if (facts.admitting && (!facts.prepared || facts.admissionProtocol === null)) return 'conflict';
  if (facts.prepared && facts.prepared.placementKey !== expected.placementKey) return 'conflict';
  if (facts.admitting && (facts.admitting.initialMessageId !== expected.initialMessageId
    || facts.admitting.placementKey !== expected.placementKey)) return 'conflict';
  if (facts.admitted && facts.admitted.initialMessageId !== expected.initialMessageId) return 'conflict';
  if (evidence === 'conflict') return 'conflict';
  if (evidence === 'unavailable') return 'unknown';
  if (evidence === 'custody' || facts.admitted) return 'confirm-custody';
  if (facts.admitting) return 'unknown';
  if (!facts.prepared) return 'verify-first';
  if (facts.admissionProtocol?.version !== 2) return 'unknown';
  return 'claim-required';
}
