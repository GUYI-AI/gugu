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

/** Stored descriptors are tagged, so arbitrary provider objects cannot impersonate a payload reference. */
export function encodeTurnValue(value: unknown, files: TurnPayloadFiles, field?: string, images = turnImages(value)): StoredTurnValue {
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
    const object = value as Record<string, unknown>;
    encoded = { t: 'object', values: Object.entries(object).filter(([, one]) => one !== undefined)
      .map(([key, one]) => [key, encodeTurnValue(one, files, key, images)]) };
  } else throw new Error('Unsupported value in stored transcript');
  return compact(encoded, files);
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
