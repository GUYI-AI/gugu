import { randomUUID } from 'node:crypto';

export type WindowOlderHostBinding = { conversationId: string; sessionId: string; scope: string; branchLineage: string };
export type WindowOlderHostPosition = { kind: 'canonical'; beforeStoredSeq: number | null } | { kind: 'native'; locatorRef: string };
type Entry = { ref: string; position: WindowOlderHostPosition };
type Owner = { binding: string; closed: boolean; current: Entry; previous?: Entry };
function binding(input: WindowOlderHostBinding) {
  if (!/^[a-f0-9]{64}$/.test(input.scope)
    || ![input.conversationId, input.sessionId, input.branchLineage].every(value => typeof value === 'string' && value.length > 0 && value.length <= 256))
    throw new Error('Invalid Older owner binding');
  return JSON.stringify([input.conversationId, input.sessionId, input.scope, input.branchLineage]);
}
function position(input: WindowOlderHostPosition): WindowOlderHostPosition {
  if (input.kind === 'canonical') {
    if (input.beforeStoredSeq !== null && (!Number.isSafeInteger(input.beforeStoredSeq) || input.beforeStoredSeq < 0)) throw new Error('Invalid canonical position');
    return { kind: 'canonical', beforeStoredSeq: input.beforeStoredSeq };
  }
  if (input.kind !== 'native' || typeof input.locatorRef !== 'string' || !input.locatorRef.length || input.locatorRef.length > 512)
    throw new Error('Invalid native position');
  return { kind: 'native', locatorRef: input.locatorRef };
}

/** Two scalar positions per host owner, no source bytes or historical page list.
 * Only opaque refs cross the wire. The previous position permits an idempotent
 * retry if a page response was lost. Older refs become explicit invalid cursors.
 * This capability owns no resident version: the page adapter must acquire the
 * actual receipt/projection pin before publishing and release it on eviction. */
export function createWindowOlderCursors() {
  const owners = new WeakMap<object, Owner>();
  function selected(owner: object, input: WindowOlderHostBinding, ref: string) {
    const found = owners.get(owner);
    if (!found || found.closed || found.binding !== binding(input) || (found.current.ref !== ref && found.previous?.ref !== ref)) return null;
    return found;
  }
  return {
    prepare(owner: object, input: WindowOlderHostBinding, start: WindowOlderHostPosition) {
      const current: Entry = { ref: `older:${randomUUID()}`, position: position(start) };
      const found: Owner = { binding: binding(input), closed: false, current }; owners.set(owner, found);
      return { cursorRef: current.ref, release() { if (owners.get(owner) === found) found.closed = true; } };
    },
    read(owner: object, input: WindowOlderHostBinding, ref: string) {
      const found = selected(owner, input, ref); if (!found) return null;
      return position(found.current.ref === ref ? found.current.position : found.previous!.position);
    },
    advance(owner: object, input: WindowOlderHostBinding, ref: string, next: WindowOlderHostPosition) {
      const found = selected(owner, input, ref); if (!found) return null;
      const target = position(next);
      if (found.current.ref !== ref) return JSON.stringify(found.current.position) === JSON.stringify(target) ? found.current.ref : null;
      found.previous = found.current; found.current = { ref: `older:${randomUUID()}`, position: target }; return found.current.ref;
    },
    close(owner: object) { const found = owners.get(owner); if (found) found.closed = true; },
  };
}
