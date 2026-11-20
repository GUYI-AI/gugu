import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { TranscriptTurn } from '@gugu/session-core/acp';
import { messageReferenceId } from '@gugu/session-core/acp/client';
import { encodeTurnValue, decodeTurnValue, turnImages, turnValueRoots, type StoredTurnValue } from './session-turn-codec';
import type { TurnPayloadFiles } from './session-turn-payloads';
import { ownTurnFieldsPayloads, registerTurnPayloads, turnPayloadFiles } from './session-turn-payload-owners';
import { runTurnRows } from './session-turn-sql';
export { turnPayloadFiles } from './session-turn-payload-owners';

type Fields = Record<string, unknown>;
type Node = { key: string; parent: string; collection: string; kind: string; ordinal: number; children: boolean; fields: Fields };
type Head = { base: 'legacy' | 'empty'; revision: number };
type NodeRow = { node_key: string; parent_key: string; collection: string; kind: string; ordinal: number; children: number; removed: number; reset_fields: number };
type FieldRow = { node_key: string; field: string; value: string | null };
export type StoredTurnInput = { id: string; data?: string; revision?: number };
export const normalizedTurnMarker = (rowId: string) => JSON.stringify({ storageVersion: 2, rowId });

function flatten(turn: TranscriptTurn): Map<string, Node> {
  const nodes = new Map<string, Node>();
  const root: Fields = { ...turn };
  delete root.items; delete root.terminals;
  nodes.set('root', { key: 'root', parent: '', collection: 'root', kind: 'root', ordinal: 0, children: turn.terminals !== undefined, fields: root });
  const visit = (items: readonly unknown[], parent: string, collection: string) => {
    const occurrences = new Map<string, number>();
    items.forEach((item, ordinal) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('Invalid stored transcript node');
      const fields: Fields = { ...item }, identity = String(fields.id ?? fields.terminalId ?? ordinal);
      const occurrence = occurrences.get(identity) ?? 0; occurrences.set(identity, occurrence + 1);
      const key = createHash('sha256').update(JSON.stringify([parent, collection, identity, occurrence])).digest('hex');
      const children = fields.children;
      if (children !== undefined && !Array.isArray(children)) throw new Error('Invalid transcript children');
      delete fields.children;
      nodes.set(key, { key, parent, collection, kind: String(fields.kind ?? 'terminal'), ordinal, children: children !== undefined, fields });
      if (children !== undefined) visit(children as unknown[], key, 'children');
    });
  };
  visit(turn.items, 'root', 'items');
  if (turn.terminals !== undefined) visit(turn.terminals, 'root', 'terminals');
  return nodes;
}

function materialize(nodes: Map<string, Node>): TranscriptTurn {
  const root = nodes.get('root');
  if (!root) throw new Error('Stored turn has no root');
  const lists = new Map<string, Node[]>();
  for (const node of nodes.values()) if (node.key !== 'root') {
    if (!nodes.has(node.parent)) throw new Error('Stored turn node has no parent');
    const key = JSON.stringify([node.parent, node.collection]), list = lists.get(key) ?? [];
    list.push(node); lists.set(key, list);
  }
  const building = new Set<string>();
  const children = (parent: string, collection: string): unknown[] => {
    if (building.has(parent)) throw new Error('Cyclic stored turn');
    building.add(parent);
    const result = (lists.get(JSON.stringify([parent, collection])) ?? []).sort((a, b) => a.ordinal - b.ordinal).map(node => ({
      ...node.fields, ...(node.children ? { children: children(node.key, 'children') } : {}),
    }));
    building.delete(parent); return result;
  };
  return { ...root.fields, items: children('root', 'items'), ...(root.children ? { terminals: children('root', 'terminals') } : {}) } as TranscriptTurn;
}

/** The single decoder for legacy-only, legacy-plus-revisions and new normalized history. */
export function readSessionTurn(connection: Database.Database, row: StoredTurnInput, options: { headerOnly?: boolean; messagesOnly?: boolean } = {}): TranscriptTurn {
  const head = connection.prepare('SELECT base,revision FROM session_turn_heads WHERE row_id=?').get(row.id) as Head | undefined;
  const projectLegacy = head?.base !== 'empty' && (options.headerOnly || options.messagesOnly);
  const serialized = projectLegacy
    ? (connection.prepare("SELECT json_remove(data,'$.items','$.terminals') AS data FROM session_turns WHERE id=?").get(row.id) as { data: string } | undefined)?.data
    : row.data ?? (connection.prepare('SELECT data FROM session_turns WHERE id=?').get(row.id) as { data: string } | undefined)?.data;
  if (serialized === undefined) throw new Error('Stored turn row is missing');
  const data: unknown = JSON.parse(serialized);
  const marker = data && typeof data === 'object' && 'storageVersion' in data && 'rowId' in data && !('items' in data);
  if (!head && marker) throw new Error('Normalized turn is missing its committed head');
  if (head && (!['legacy', 'empty'].includes(head.base) || (head.base === 'empty' && (!marker || (data as { storageVersion: unknown }).storageVersion !== 2
    || (data as { rowId: unknown }).rowId !== row.id)))) throw new Error('Invalid normalized turn binding');
  if (!head && !projectLegacy) return data as TranscriptTurn;
  let nodes: Map<string, Node>;
  if (projectLegacy) {
    nodes = new Map([['root', { key: 'root', parent: '', collection: 'root', kind: 'root', ordinal: 0, children: false, fields: data as Fields }]]);
    if (options.messagesOnly) {
      // Count every identity, but transfer only message bodies. A legacy tool can contain tens of MB.
      const occurrences = new Map<string, number>();
      const items = connection.prepare(`SELECT CAST(key AS INTEGER) AS ordinal,
        CAST(coalesce(json_extract(value,'$.id'),json_extract(value,'$.terminalId'),key) AS TEXT) AS identity,
        CASE WHEN json_extract(value,'$.kind')='message' THEN value END AS data
        FROM json_each((SELECT data FROM session_turns WHERE id=?),'$.items') ORDER BY CAST(key AS INTEGER)`);
      for (const item of items.iterate(row.id) as Iterable<{ ordinal: number; identity: string; data: string | null }>) {
        const occurrence = occurrences.get(item.identity) ?? 0; occurrences.set(item.identity, occurrence + 1);
        if (item.data === null) continue;
        const key = createHash('sha256').update(JSON.stringify(['root', 'items', item.identity, occurrence])).digest('hex');
        nodes.set(key, { key, parent: 'root', collection: 'items', kind: 'message', ordinal: item.ordinal, children: false, fields: JSON.parse(item.data) as Fields });
      }
    }
  } else nodes = head?.base === 'legacy' ? flatten(data as TranscriptTurn) : new Map<string, Node>();
  for (const node of head ? connection.prepare('SELECT * FROM session_turn_nodes WHERE row_id=?').all(row.id) as NodeRow[] : []) {
    if (node.removed) { nodes.delete(node.node_key); continue; }
    nodes.set(node.node_key, { key: node.node_key, parent: node.parent_key, collection: node.collection,
      kind: node.kind, ordinal: node.ordinal, children: Boolean(node.children), fields: node.reset_fields ? Object.create(null) as Fields : nodes.get(node.node_key)?.fields ?? Object.create(null) as Fields });
  }
  if (options.headerOnly || options.messagesOnly) {
    for (const [key, node] of nodes) if (key !== 'root' && (options.headerOnly || node.collection !== 'items' || node.kind !== 'message')) nodes.delete(key);
    const root = nodes.get('root'); if (root) root.children = false;
  }
  const files = head ? turnPayloadFiles(connection) : undefined;
  for (const field of head ? connection.prepare('SELECT node_key,field,value FROM session_turn_fields WHERE row_id=?').all(row.id) as FieldRow[] : []) {
    const node = nodes.get(field.node_key);
    if (!node) continue; // A removed node's fields no longer belong to this version.
    if (field.value === null) delete node.fields[field.field];
    else node.fields[field.field] = decodeTurnValue(JSON.parse(field.value) as StoredTurnValue, files!);
  }
  return materialize(nodes);
}

export function sessionTurnRevision(connection: Database.Database, row: StoredTurnInput): number {
  return (connection.prepare('SELECT revision FROM session_turn_heads WHERE row_id=?').get(row.id) as { revision: number } | undefined)?.revision ?? row.revision ?? 0;
}

type Change = { node: Node; removed: boolean; fields: Array<{ name: string; value: string | null }> };
export type PreparedSessionTurn = { marker: string; changed: boolean; source(): { files: TurnPayloadFiles; value: StoredTurnValue }; commit(): void };

/** Files become durable before the caller's canonical transaction. Old data is never rewritten. */
export function prepareSessionTurn(connection: Database.Database, row: StoredTurnInput, turn: TranscriptTurn, insert: boolean): PreparedSessionTurn {
  const head = connection.prepare('SELECT base,revision FROM session_turn_heads WHERE row_id=?').get(row.id) as Head | undefined;
  const encodedBefore = new Map<string, Map<string, string | null>>();
  let previous = new Map<string, Node>();
  if (!insert && head?.base === 'empty') {
    // Compare bounded descriptors. Updating one terminal must not decode unrelated images or tool bodies.
    for (const node of connection.prepare('SELECT * FROM session_turn_nodes WHERE row_id=? AND removed=0').all(row.id) as NodeRow[]) {
      previous.set(node.node_key, { key: node.node_key, parent: node.parent_key, collection: node.collection, kind: node.kind,
        ordinal: node.ordinal, children: Boolean(node.children), fields: Object.create(null) as Fields });
    }
    for (const field of connection.prepare('SELECT node_key,field,value FROM session_turn_fields WHERE row_id=?').all(row.id) as FieldRow[]) {
      const fields = encodedBefore.get(field.node_key) ?? new Map<string, string | null>();
      fields.set(field.field, field.value); encodedBefore.set(field.node_key, fields);
      if (field.value !== null) { const node = previous.get(field.node_key); if (node) node.fields[field.field] = true; }
    }
  } else if (!insert) previous = flatten(readSessionTurn(connection, row));
  const next = flatten(turn), files = turnPayloadFiles(connection), changes: Change[] = [], images = turnImages(turn);
  const encodedAfter = new Map<string, Map<string, string | null>>();
  for (const [key, node] of next) {
    const prior = previous.get(key), fields: Change['fields'] = [];
    for (const name of new Set([...Object.keys(prior?.fields ?? {}), ...Object.keys(node.fields)])) {
      const before = prior?.fields[name], after = node.fields[name];
      if (head?.base !== 'empty' && isDeepStrictEqual(before, after)) continue;
      const value = after === undefined ? null : JSON.stringify(encodeTurnValue(after, files, name, images));
      const encoded = encodedAfter.get(key) ?? new Map<string, string | null>();
      encoded.set(name, value); encodedAfter.set(key, encoded);
      if (head?.base === 'empty' && (encodedBefore.get(key)?.get(name) ?? null) === value) continue;
      fields.push({ name, value });
    }
    if (fields.length || !prior || prior.parent !== node.parent || prior.collection !== node.collection
      || prior.kind !== node.kind || prior.ordinal !== node.ordinal || prior.children !== node.children) changes.push({ node, removed: false, fields });
  }
  for (const [key, node] of previous) if (!next.has(key)) changes.push({ node, removed: true, fields: [] });
  const textChanged = insert || changes.some(change => change.node.key === 'root'
    ? change.fields.some(field => field.name === 'id' || field.name === 'referenceId')
    : (change.node.kind === 'message' || previous.get(change.node.key)?.kind === 'message')
      && (change.removed || !previous.has(change.node.key) || change.fields.some(field => ['kind', 'id', 'role', 'text'].includes(field.name))));
  const base = head?.base ?? (insert ? 'empty' : 'legacy');
  const revision = (head?.revision ?? row.revision ?? 0) + (insert || !changes.length ? 0 : 1);
  const sourceValue = (): StoredTurnValue => {
    const lists = new Map<string, Node[]>();
    for (const node of next.values()) if (node.key !== 'root') {
      const key = JSON.stringify([node.parent, node.collection]), list = lists.get(key) ?? [];
      list.push(node); lists.set(key, list);
    }
    const array = (parent: string, collection: string): StoredTurnValue => ({ t: 'array', values:
      (lists.get(JSON.stringify([parent, collection])) ?? []).sort((a, b) => a.ordinal - b.ordinal).map(describe) });
    const describe = (node: Node): StoredTurnValue => {
      const values: Array<[string, StoredTurnValue]> = Object.entries(node.fields).filter(([, value]) => value !== undefined).map(([name, value]) => {
        const encoded = encodedAfter.get(node.key)?.get(name);
        return [name, encoded == null ? encodeTurnValue(value, files, name, images) : JSON.parse(encoded) as StoredTurnValue];
      });
      if (node.key === 'root') {
        values.push(['items', array('root', 'items')]);
        if (node.children) values.push(['terminals', array('root', 'terminals')]);
      } else if (node.children) values.push(['children', array(node.key, 'children')]);
      return { t: 'object', values };
    };
    return describe(next.get('root')!);
  };
  return { marker: normalizedTurnMarker(row.id), changed: changes.length > 0,
    source: () => ({ files, value: sourceValue() }), commit() {
    if (!connection.inTransaction) throw new Error('Turn parts must share the canonical transaction');
    registerTurnPayloads(connection);
    if (!changes.length && head) return;
    const notification = turn.items.find(item => item.kind === 'message' && item.ownerNotification?.sourceTurnId);
    connection.prepare(`INSERT INTO session_turn_heads(row_id,base,revision,reference_id,outcome_kind,started_at,notified_source,text_bytes) VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(row_id) DO UPDATE SET revision=excluded.revision,reference_id=excluded.reference_id,outcome_kind=excluded.outcome_kind,
        started_at=excluded.started_at,notified_source=excluded.notified_source,text_bytes=excluded.text_bytes`).run(row.id, base, revision, turn.referenceId ?? null,
          turn.outcome?.kind ?? null, turn.startedAt ?? null, notification?.kind === 'message' ? notification.ownerNotification?.sourceTurnId ?? null : null,
          turn.items.reduce((bytes, item) => bytes + (item.kind === 'message' ? Buffer.byteLength(item.text) : 0), 0));
    runTurnRows(connection, 'INSERT INTO session_turn_nodes(row_id,node_key,parent_key,collection,kind,ordinal,children,removed,reset_fields) VALUES',
      changes.map(({ node, removed }) => [row.id, node.key, node.parent, node.collection, node.kind, node.ordinal, Number(node.children), Number(removed), 0]), `
      ON CONFLICT(row_id,node_key) DO UPDATE SET parent_key=excluded.parent_key,collection=excluded.collection,kind=excluded.kind,
        ordinal=excluded.ordinal,children=excluded.children,removed=excluded.removed,
        reset_fields=CASE WHEN session_turn_nodes.removed=1 THEN 1 ELSE session_turn_nodes.reset_fields END`);
    for (const change of changes) {
      if (change.removed) connection.prepare('DELETE FROM session_turn_fields WHERE row_id=? AND node_key=?').run(row.id, change.node.key);
    }
    const fields = changes.flatMap(change => change.fields.map(field => ({ ...field, nodeKey: change.node.key })));
    runTurnRows(connection, 'INSERT INTO session_turn_fields(row_id,node_key,field,value) VALUES',
      fields.map(field => [row.id, field.nodeKey, field.name, field.value]),
      'ON CONFLICT(row_id,node_key,field) DO UPDATE SET value=excluded.value');
    ownTurnFieldsPayloads(connection, row.id, fields.map(field => ({ nodeKey: field.nodeKey, field: field.name,
      roots: field.value === null ? [] : turnValueRoots(JSON.parse(field.value) as StoredTurnValue) })));
    if (!insert && changes.length) connection.prepare('DELETE FROM session_window_commit_positions WHERE row_id=?').run(row.id);
    if (textChanged) syncSessionTurnText(connection, row.id, turn);
  } };
}

/** Indexed scalar projection of the same committed head, with explicit legacy format selection. */
export function sessionTurnHeaderSql(field: 'reference_id' | 'outcome_kind' | 'started_at' | 'notified_source', legacyPath: string, table = 'session_turns'): string {
  return `CASE WHEN EXISTS (SELECT 1 FROM session_turn_heads h WHERE h.row_id=${table}.id)
    THEN (SELECT h.${field} FROM session_turn_heads h WHERE h.row_id=${table}.id)
    ELSE json_extract(${table}.data, '${legacyPath}') END`;
}

/**
 * Whether a root turn field currently holds an object, without decoding the turn. A committed root field overrides
 * the legacy body (a stored NULL is its removal); a turn born normalized has no legacy body to fall back to.
 */
export function sessionTurnRootObjectSql(field: string, table = 'session_turns'): string {
  if (!/^[A-Za-z][A-Za-z0-9]*$/.test(field)) throw new Error('Invalid turn field name');
  const stored = `SELECT f.value FROM session_turn_fields f WHERE f.row_id=${table}.id AND f.node_key='root' AND f.field='${field}'`;
  return `(CASE WHEN EXISTS (${stored}) THEN coalesce(json_extract((${stored}), '$.t') IN ('object', 'node'), 0)
    WHEN EXISTS (SELECT 1 FROM session_turn_heads h WHERE h.row_id=${table}.id AND h.base='empty') THEN 0
    ELSE coalesce(json_type(${table}.data, '$.${field}') = 'object', 0) END)`;
}

/** Message identity/text only. A tool, picture, terminal or outcome change performs no FTS writes. */
export function syncSessionTurnText(connection: Database.Database, rowId: string, turn: TranscriptTurn): void {
  const owner = connection.prepare('SELECT session_id,seq FROM session_turns WHERE id=?').get(rowId) as { session_id: string; seq: number } | undefined;
  if (!owner) throw new Error('Normalized turn has no canonical row');
  const prior = connection.prepare('SELECT id,item_id,role,text FROM turn_text_rows WHERE session_id=? AND seq=?').all(owner.session_id, owner.seq) as
    { id: number; item_id: string; role: string; text: string }[];
  const desired = turn.items.flatMap(item => {
    if (item.kind !== 'message') return [];
    const text = (connection.prepare('SELECT search_text(?) AS text').get(item.text) as { text: string | null }).text;
    return text ? [{ item_id: messageReferenceId(turn, item.id) ?? item.id, role: item.role, text }] : [];
  });
  const key = (value: { item_id: string; role: string; text: string }) => JSON.stringify([value.item_id, value.role, value.text]);
  const remaining = new Map<string, typeof prior>();
  for (const old of prior) { const matches = remaining.get(key(old)) ?? []; matches.push(old); remaining.set(key(old), matches); }
  for (const value of desired) {
    if (remaining.get(key(value))?.pop()) continue;
    connection.prepare('INSERT INTO turn_text_rows(session_id,seq,item_id,role,text) VALUES (?,?,?,?,?)').run(owner.session_id, owner.seq, value.item_id, value.role, value.text);
  }
  for (const matches of remaining.values()) for (const old of matches) connection.prepare('DELETE FROM turn_text_rows WHERE id=?').run(old.id);
}
