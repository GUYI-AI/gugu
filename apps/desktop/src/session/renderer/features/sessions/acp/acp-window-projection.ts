import { transcriptTurnSchema, type TranscriptTurn } from '@gugu/session-core/acp/client';
import type { WindowLivePosition, WindowLiveResult } from '@gugu/session-wire/session-window-live';
import {
  windowProjectionBodyReadResultSchema, windowProjectionOpenSchema, windowProjectionPageSchema, windowProjectionReadResultSchema,
  type WindowProjectionApi, type WindowProjectionFieldPage, type WindowProjectionHeader, type WindowProjectionPage,
} from '@gugu/session-wire/session-window-projection';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Owner = { conversationId: string; subscriptionId: string };
type FieldKind = 'string' | 'array' | 'object';

const fault = (code: string, message: string) => Object.assign(new Error(message), { code });
const invalid = () => fault('invalid_projection', 'The committed history projection does not match its request');

function decode<T>(schema: { safeParse(value: unknown): { success: false } | { success: true; data: WindowLiveResult<unknown> } },
  value: unknown, shape: { safeParse(value: unknown): { success: boolean } }): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw invalid();
  if (!parsed.data.ok) throw fault(parsed.data.error.code, parsed.data.error.message);
  if (!shape.safeParse(parsed.data.value).success) throw invalid();
  return parsed.data.value as T;
}

/**
 * Rebuild one committed canonical turn from its host projection. The open,
 * entity pages and field pages are the turn's own canonical JSON, read in
 * bounded pages through host capabilities; nothing is guessed or defaulted.
 * The resident version is released on every exit, including failure.
 */
export async function materializeCommittedTurn(
  api: WindowProjectionApi, owner: Owner, position: WindowLivePosition, isCurrent: () => boolean,
): Promise<TranscriptTurn> {
  const current = () => { if (!isCurrent()) throw fault('unsubscribed', 'The history view was released'); };
  const readField = async (handle: string): Promise<WindowProjectionFieldPage> => {
    current();
    const page = decode<WindowProjectionFieldPage>(windowProjectionBodyReadResultSchema, await api.readBody({ ...owner, handle }),
      { safeParse: () => ({ success: true }) });
    current();
    return page;
  };
  const readString = async (handle: string): Promise<string> => {
    let text = '', next: string | null = handle, offset = 0;
    while (next) {
      const page = await readField(next);
      if (page.kind !== 'body' || page.offset !== offset) throw invalid();
      text += page.text; offset += new TextEncoder().encode(page.text).byteLength; next = page.next;
    }
    return text;
  };
  const readValue = async (kind: FieldKind, handle: string): Promise<Json> => {
    if (kind === 'string') return readString(handle);
    const array: Json[] = [], object: Record<string, Json> = {};
    let next: string | null = handle, ordinal = 0;
    while (next) {
      const page = await readField(next);
      if (page.kind !== 'values' || page.containerKind !== kind) throw invalid();
      for (const entry of page.entries) {
        if (entry.ordinal !== ordinal++) throw invalid();
        const value = entry.value.kind === 'scalar' ? entry.value.value : await readValue(entry.value.fieldKind, entry.value.handle);
        if (kind === 'array') array.push(value);
        else object[await readString(entry.key!)] = value;
      }
      next = page.next;
    }
    return kind === 'array' ? array : object;
  };
  const readHeader = async (header: WindowProjectionHeader): Promise<Record<string, Json>> => {
    const value: Record<string, Json> = {};
    const assign = (path: string, field: Json) => {
      const [name, child] = path.split('.');
      if (child === undefined) { value[name] = field; return; }
      const parent = value[name];
      value[name] = { ...(parent && typeof parent === 'object' && !Array.isArray(parent) ? parent : {}), [child]: field };
    };
    for (const [path, field] of Object.entries(header.values)) assign(path, field);
    for (const field of header.fields) assign(field.field, await readValue(field.kind, field.handle));
    return value;
  };

  current();
  const opened = decode<{ lease: string; position: WindowLivePosition; root: WindowProjectionHeader; count: number; next: string | null }>(
    windowProjectionReadResultSchema, await api.read({ ...owner, kind: 'open', position: { ...position } }), windowProjectionOpenSchema);
  try {
    current();
    if (opened.position.projectionId !== position.projectionId || opened.position.referenceId !== position.referenceId) throw invalid();
    const root = await readHeader(opened.root);
    const entities = new Map<string, Record<string, Json>>();
    const children = new Map<string | null, Record<string, Json>[]>();
    const terminals: Record<string, Json>[] = [];
    let next = opened.next, ordinal = 0;
    while (next) {
      current();
      const page = decode<WindowProjectionPage>(windowProjectionReadResultSchema, await api.read({ ...owner, kind: 'page', cursor: next }),
        windowProjectionPageSchema);
      if (page.lease !== opened.lease || page.ordinal !== ordinal++ || entities.has(page.entityId)) throw invalid();
      const entity = await readHeader(page.header);
      for (const body of page.bodies) entity[body.field] = await readString(body.handle);
      entities.set(page.entityId, entity);
      if (page.header.target === 'terminal') terminals.push(entity);
      else {
        if (page.parentEntityId !== null && !entities.has(page.parentEntityId)) throw invalid();
        const siblings = children.get(page.parentEntityId) ?? [];
        siblings.push(entity); children.set(page.parentEntityId, siblings);
      }
      if (page.hasChildren) entity.children = [];
      next = page.next;
    }
    if (ordinal !== opened.count) throw invalid();
    for (const [parent, rows] of children) if (parent !== null) {
      const entity = entities.get(parent)!;
      entity.children = rows;
    }
    const turn = transcriptTurnSchema.safeParse({ ...root, items: children.get(null) ?? [], ...(terminals.length ? { terminals } : {}) });
    if (!turn.success || turn.data.referenceId !== position.referenceId) throw invalid();
    return turn.data;
  } finally {
    void api.read({ ...owner, kind: 'release', lease: opened.lease }).catch(() => undefined);
  }
}
