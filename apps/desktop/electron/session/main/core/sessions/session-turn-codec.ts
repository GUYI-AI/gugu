import { randomUUID } from 'node:crypto';
import { TurnPayloadFiles, type TurnPayloadRef } from './session-turn-payloads';

type Primitive = string | number | boolean | null;
export type StoredTurnValue =
  | { t: 'value'; value: Primitive }
  | { t: 'text' | 'base64' | 'node'; ref: TurnPayloadRef }
  | { t: 'array'; values: StoredTurnValue[] }
  | { t: 'object'; values: Array<[string, StoredTurnValue]> }
  | { t: 'json'; indent: 0 | 2; value: StoredTurnValue };
const INLINE_TEXT_BYTES = 1024;
export const TURN_PART_BYTES = 8 * 1024;
type ImagePayloads = Map<string, TurnPayloadRef | null | undefined>;

/** Discover image spellings without writing them: an unchanged legacy body stays untouched. */
export function turnImages(value: unknown, images: ImagePayloads = new Map(), seen = new WeakSet<object>()): ImagePayloads {
  if (!value || typeof value !== 'object' || seen.has(value)) return images;
  seen.add(value);
  const object = value as Record<string, unknown>, mimeType = object.mimeType ?? object.media_type;
  if (typeof object.data === 'string' && typeof mimeType === 'string' && mimeType.startsWith('image/') && !images.has(object.data)) images.set(object.data, undefined);
  for (const child of Object.values(object)) turnImages(child, images, seen);
  return images;
}

/**
 * A provider's raw JSON usually carries a sibling field's body (rawOutput.aggregatedOutput = outputText). Swap each such
 * body's JSON literal for a unique placeholder and run the exact round-trip check on that small skeleton. A string value
 * serializes to its own literal wherever it sits, so when the skeleton round-trips and every placeholder comes back as one
 * whole string value, the whole value round-trips too. Any doubt falls back to the full check; the stored form is the same.
 */
export function sharedJson(value: string, bodies: readonly string[]): { parsed: object; indent: 0 | 2 } | undefined {
  const token = randomUUID();
  if (value.includes(token)) return undefined;
  const slots = new Map<string, string>(), cuts: Array<{ at: number; end: number; placeholder: string }> = [];
  for (const body of new Set(bodies)) {
    if (body === value || body.length > value.length || cuts.length >= 16) continue;
    const literal = JSON.stringify(body);
    for (let at = value.indexOf(literal); at !== -1 && cuts.length < 16; at = value.indexOf(literal, at + literal.length)) {
      if (cuts.some(cut => at < cut.end && cut.at < at + literal.length)) continue;
      const placeholder = `\u0000gugu-shared-body:${token}:${cuts.length}`;
      slots.set(placeholder, body); cuts.push({ at, end: at + literal.length, placeholder });
    }
  }
  if (!cuts.length) return undefined;
  cuts.sort((a, b) => a.at - b.at);
  let skeleton = '', from = 0;
  for (const cut of cuts) { skeleton += value.slice(from, cut.at) + JSON.stringify(cut.placeholder); from = cut.end; }
  skeleton += value.slice(from);
  let parsed: unknown;
  try { parsed = JSON.parse(skeleton); } catch { return undefined; }
  if (!parsed || typeof parsed !== 'object') return undefined;
  const indent = ([2, 0] as const).find(one => JSON.stringify(parsed, null, one) === skeleton);
  if (indent === undefined) return undefined;
  const restored = new Set<string>();
  const restore = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    for (const key of Object.keys(node)) {
      const child = (node as Record<string, unknown>)[key];
      // JSON.parse made every key an own data property, "__proto__" included, so this sets a value and never a prototype.
      if (typeof child === 'string' && slots.has(child)) { (node as Record<string, unknown>)[key] = slots.get(child); restored.add(child); }
      else restore(child);
    }
  };
  restore(parsed);
  // Each placeholder's text occurs once, so every slot restored means each cut was exactly one whole string value. A cut
  // that became a key, or text inside a longer string (a body literal right after an escaped quote), leaves a slot over.
  if (restored.size !== slots.size) return undefined;
  return { parsed, indent };
}

/** Stored descriptors are tagged, so arbitrary provider objects cannot impersonate a payload reference. */
export function encodeTurnValue(value: unknown, files: TurnPayloadFiles, field?: string, images = turnImages(value),
  bodies: readonly string[] = []): StoredTurnValue {
  let encoded: StoredTurnValue;
  if (value === null || typeof value === 'number' || typeof value === 'boolean') encoded = { t: 'value', value };
  else if (typeof value === 'string') {
    if (images.has(value)) {
      let ref = images.get(value);
      if (ref === undefined) {
        const bytes = Buffer.from(value, 'base64');
        ref = bytes.toString('base64') === value ? files.putBytes(bytes) : null;
        images.set(value, ref);
      }
      if (ref) return { t: 'base64', ref };
    }
    if (field === 'rawOutput' || field === 'rawInput') {
      const shared = bodies.length ? sharedJson(value, bodies) : undefined;
      if (shared) {
        turnImages(shared.parsed, images);
        return compact({ t: 'json', indent: shared.indent, value: encodeTurnValue(shared.parsed, files, undefined, images) }, files);
      }
      let parsed: unknown;
      try { parsed = JSON.parse(value); } catch { /* A provider's plain text is not JSON. */ }
      if (parsed !== undefined && parsed !== null && typeof parsed === 'object') {
        turnImages(parsed, images);
        for (const indent of [2, 0] as const) {
          if (JSON.stringify(parsed, null, indent) === value) return compact({ t: 'json', indent, value: encodeTurnValue(parsed, files, undefined, images) }, files);
        }
      }
    }
    encoded = Buffer.byteLength(value) < INLINE_TEXT_BYTES ? { t: 'value', value } : { t: 'text', ref: files.putText(value) };
  } else if (Array.isArray(value)) encoded = { t: 'array', values: Array.from(value, one => encodeTurnValue(one === undefined ? null : one, files, undefined, images)) };
  else if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, one]) => one !== undefined);
    const siblings = sharedBodies(entries.map(([, one]) => one));
    encoded = { t: 'object', values: entries.map(([key, one]) => [key, encodeTurnValue(one, files, key, images, siblings)]) };
  } else throw new Error('Unsupported value in stored transcript');
  return compact(encoded, files);
}

/** Sibling strings worth matching inside a raw JSON field: only bodies that would be stored out of line. */
export function sharedBodies(values: readonly unknown[]): string[] {
  return values.filter((one): one is string => typeof one === 'string' && one.length >= INLINE_TEXT_BYTES);
}

function compact(value: StoredTurnValue, files: TurnPayloadFiles): StoredTurnValue {
  const serialized = JSON.stringify(value);
  return Buffer.byteLength(serialized) <= TURN_PART_BYTES ? value : { t: 'node', ref: files.putText(serialized, turnValueRoots(value)) };
}

export function turnValueRoots(value: StoredTurnValue): TurnPayloadRef[] {
  switch (value.t) {
    case 'text': case 'base64': case 'node': return [value.ref];
    case 'array': return value.values.flatMap(turnValueRoots);
    case 'object': return value.values.flatMap(([, child]) => turnValueRoots(child));
    case 'json': return turnValueRoots(value.value);
    case 'value': return [];
  }
}

export function decodeTurnValue(value: StoredTurnValue, files: TurnPayloadFiles): unknown {
  if (!value || typeof value !== 'object') throw new Error('Invalid stored turn value');
  switch (value.t) {
    case 'value':
      if (value.value !== null && !['string', 'number', 'boolean'].includes(typeof value.value)) throw new Error('Invalid stored primitive');
      return value.value;
    case 'text': return files.readText(value.ref);
    case 'base64': return files.readBytes(value.ref).toString('base64');
    case 'node': return decodeTurnValue(JSON.parse(files.readText(value.ref)) as StoredTurnValue, files);
    case 'array': return value.values.map(one => decodeTurnValue(one, files));
    case 'object': return Object.fromEntries(value.values.map(([key, one]) => [key, decodeTurnValue(one, files)]));
    case 'json':
      if (value.indent !== 0 && value.indent !== 2) throw new Error('Invalid stored JSON format');
      return JSON.stringify(decodeTurnValue(value.value, files), null, value.indent);
    default: throw new Error('Unknown stored turn value version');
  }
}
