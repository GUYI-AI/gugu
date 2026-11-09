import { readDeliveryEnvelope } from './deliveryEnvelope';

/** Absence describes the checked native snapshot, never proof that its writer has finished. */
export type NativeInputEvidence =
  | { state: 'received'; nativeReceiptId: string }
  | { state: 'absent'; reason: 'native_input_absent' }
  | { state: 'incomplete'; reason: string; detail?: string };
export type NativeInputLookup = ((input: { id: string; text: string }) => Promise<NativeInputEvidence>) & {
  /** Recheck external session bindings synchronously after the consumer's final await, before committing evidence. */
  isCurrent?(): boolean;
};

export function deliverySourceIds(text: string): string[] {
  return readDeliveryEnvelope(text)?.segments.flatMap(segment => segment.facts?.messageId
    ? [segment.facts.messageId.replace(/^msg:/, '')] : []) ?? [];
}

/** Stable input identities only: identical prose, a reply or a partial batch is not a receipt. */
export function matchesDeliveryIdentity(input: { id: string; text: string },
  message: { id: string; text: string; clientMessageId?: string | null }): boolean {
  if (message.clientMessageId === input.id || message.id === input.id
    || (input.id.length >= 16 && message.id.includes(input.id))) return true;
  const ids = deliverySourceIds(input.text);
  if (!ids.length) return false;
  const native = new Set(deliverySourceIds(message.text));
  return ids.every(id => native.has(id));
}
