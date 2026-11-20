import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openFixture } from '@tooling/utils/db';
import type { TranscriptTurn } from '@gugu/session-core/acp';
import { prepareSessionTurn, readSessionTurn, sessionTurnRevision, sessionTurnRootObjectSql, turnPayloadFiles } from './session-turn-storage';
import { collectTurnPayloads, withTurnPayloadWrite } from './session-turn-payload-owners';
import Database from 'better-sqlite3';
import { backfillTurnText } from '@main/db/initialize';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { StoredTurnValue } from './session-turn-codec';

type Fixture = Awaited<ReturnType<typeof openFixture>>;
let fixture: Fixture;
const turn = (): TranscriptTurn => ({ id: 's:turn:s0', referenceId: 'source', seq: 0, initiator: 'user', startedAt: 10,
  items: [
    { kind: 'message', id: 's:turn:s0:message:a', seq: 0, role: 'user', text: 'searchable question' },
    { kind: 'execute-tool-call', id: 's:turn:s0:tool:a', seq: 1, toolCallId: 'a', title: 'echo', status: 'done',
      outputText: 'A'.repeat(20000), rawOutput: JSON.stringify({ aggregatedOutput: 'A'.repeat(20000), exitCode: 0 }, null, 2) },
    { kind: 'mcp-tool-call', id: 's:turn:s0:tool:b', seq: 2, toolCallId: 'b', title: 'screenshot', tool: 'screenshot', status: 'done',
      images: [{ mimeType: 'image/png', data: Buffer.from('picture'.repeat(10000)).toString('base64') }] },
  ] });

function insert(value: TranscriptTurn, legacy: boolean) {
  const row = { id: 's:0', data: JSON.stringify(value), revision: 0 };
  const prepared = legacy ? undefined : prepareSessionTurn(fixture.sqlite, row, value, true);
  fixture.sqlite.transaction(() => {
    fixture.sqlite.prepare('INSERT INTO session_turns(id,session_id,seq,turn_id,data) VALUES (?,\'s\',0,\'runtime:0\',?)')
      .run(row.id, prepared?.marker ?? row.data);
    prepared?.commit();
  })();
  return { ...row, data: prepared?.marker ?? row.data };
}

beforeEach(async () => {
  fixture = await openFixture('empty');
  fixture.sqlite.exec("INSERT INTO projects(id,name,path) VALUES ('p','P','/p'); INSERT INTO sessions(id,project_id) VALUES ('s','p');");
});
afterEach(() => fixture.close());

describe('versioned session turn storage', () => {
  it.each(['legacy', 'legacy-revised', 'normalized'] as const)('reads exactly the same history through one entry: %s', mode => {
    const original = turn(), row = insert(original, mode !== 'normalized');
    const expected = mode === 'legacy-revised' ? { ...original, outcome: { kind: 'done' as const }, endedAt: 20 } : original;
    if (mode === 'legacy-revised') fixture.sqlite.transaction(() => prepareSessionTurn(fixture.sqlite, row, expected, false).commit())();
    expect(readSessionTurn(fixture.sqlite, row)).toEqual(expected);
    expect(fixture.sqlite.prepare('SELECT data FROM session_turns WHERE id=?').get(row.id)).toEqual({ data: row.data });
    expect(readSessionTurn(fixture.sqlite, { id: row.id }, { messagesOnly: true }).items).toEqual([expected.items[0]]);
    expect(readSessionTurn(fixture.sqlite, { id: row.id }, { headerOnly: true })).toMatchObject({ id: expected.id, items: [] });
  });

  it('keeps image bytes and JSON-escaped execute output once, including repeated images in different items', () => {
    const value = turn(), image = value.items[2];
    value.items.push({ ...image, id: 'second-image', seq: 3 });
    const row = insert(value, false), files = turnPayloadFiles(fixture.sqlite);
    const descriptors = fixture.sqlite.prepare('SELECT value FROM session_turn_fields WHERE row_id=? AND field IN (\'images\',\'rawOutput\',\'outputText\') ORDER BY field')
      .all(row.id) as { value: string }[];
    const imageValues = fixture.sqlite.prepare("SELECT value FROM session_turn_fields WHERE field='images'").all() as { value: string }[];
    expect(imageValues[0].value).toBe(imageValues[1].value);
    expect(descriptors.every(part => Buffer.byteLength(part.value) <= 8192)).toBe(true);
    expect(row.data).not.toContain('picture');
    expect(readSessionTurn(fixture.sqlite, row)).toEqual(value);
    // The image is one file; both execute spellings share one SQLite payload object.
    expect(files.counters.writtenFiles).toBe(1);
    const output = JSON.parse(descriptors.find(part => (JSON.parse(part.value) as StoredTurnValue).t === 'text')!.value) as StoredTurnValue;
    if (output.t !== 'text') throw new Error('Expected shared text payload');
    expect(descriptors.some(part => (JSON.parse(part.value) as StoredTurnValue).t === 'json' && part.value.includes(output.ref.hash))).toBe(true);
    expect(fixture.sqlite.prepare(`SELECT o.bytes,o.kind,length(b.data) n FROM session_turn_payload_objects o
      JOIN session_turn_payload_inline b ON b.hash=o.hash WHERE o.hash=?`).get(output.ref.hash))
      .toEqual({ bytes: 20003, kind: 2, n: 20003 });
    expect(files.counters.writtenBytes).toBeLessThan(100000);
    expect(fixture.sqlite.prepare('SELECT max(length(CAST(value AS BLOB))) n FROM session_turn_fields').get()).toMatchObject({ n: expect.any(Number) });
  });

  it('does not attempt object or edge inserts again when a successful writer settles', async () => {
    fixture.sqlite.exec(`CREATE TEMP TABLE payload_insert_attempts(kind TEXT);
      CREATE TEMP TRIGGER count_payload_object BEFORE INSERT ON session_turn_payload_objects
        BEGIN INSERT INTO payload_insert_attempts VALUES('object'); END;
      CREATE TEMP TRIGGER count_payload_edge BEFORE INSERT ON session_turn_payload_edges
        BEGIN INSERT INTO payload_insert_attempts VALUES('edge'); END;`);
    const original = turn();
    const row = await withTurnPayloadWrite(fixture.sqlite, () => insert(original, false));
    expect(readSessionTurn(fixture.sqlite, row)).toEqual(original);
    for (const [kind, table] of [['object', 'session_turn_payload_objects'], ['edge', 'session_turn_payload_edges']]) {
      const attempts = fixture.sqlite.prepare('SELECT count(*) n FROM payload_insert_attempts WHERE kind=?').get(kind);
      expect(attempts).toEqual(fixture.sqlite.prepare(`SELECT count(*) n FROM ${table}`).get());
    }
  });

  it.each([true, false])('selects a root object field from the committed head, legacy body or normalized row (legacy=%s)', legacy => {
    const hostEnded = (): boolean => (fixture.sqlite.prepare(`SELECT ${sessionTurnRootObjectSql('hostEnd')} AS hit FROM session_turns`).get() as { hit: number }).hit === 1;
    const value = { ...turn(), hostEnd: { at: 20 } }, row = insert(value, legacy);
    expect(hostEnded()).toBe(true);
    const closed: TranscriptTurn = { ...turn(), outcome: { kind: 'done' } };
    fixture.sqlite.transaction(() => prepareSessionTurn(fixture.sqlite, row, closed, false).commit())();
    expect(readSessionTurn(fixture.sqlite, row).hostEnd).toBeUndefined();
    expect(hostEnded()).toBe(false);
    fixture.sqlite.transaction(() => prepareSessionTurn(fixture.sqlite, row, { ...closed, hostEnd: { at: 30 } }, false).commit())();
    expect(hostEnded()).toBe(true);
    expect(() => sessionTurnRootObjectSql("hostEnd' OR 1=1 --")).toThrow();
  });

  it('updates a small field without rewriting data, static image bytes or searchable message rows', () => {
    const value = turn(), row = insert(value, false), files = turnPayloadFiles(fixture.sqlite);
    const before = files.counters.writtenBytes;
    let textExtractions = 0;
    fixture.sqlite.function('search_text', { deterministic: true }, (text: unknown) => { textExtractions++; return typeof text === 'string' ? text : null; });
    fixture.sqlite.exec(`CREATE TABLE search_mutations (n INTEGER); INSERT INTO search_mutations VALUES(0);
      CREATE TRIGGER count_search_insert AFTER INSERT ON turn_text_rows BEGIN UPDATE search_mutations SET n=n+1; END;
      CREATE TRIGGER count_search_delete AFTER DELETE ON turn_text_rows BEGIN UPDATE search_mutations SET n=n+1; END;`);
    const revised = { ...value, outcome: { kind: 'error' as const, reason: 'process_closed' as const } };
    const prepared = prepareSessionTurn(fixture.sqlite, row, revised, false);
    fixture.sqlite.transaction(() => prepared.commit())();
    expect(readSessionTurn(fixture.sqlite, row)).toEqual(revised);
    expect(files.counters.writtenBytes).toBe(before);
    expect(fixture.sqlite.prepare('SELECT n FROM search_mutations').get()).toEqual({ n: 0 });
    expect(textExtractions).toBe(0);
    expect(fixture.sqlite.prepare('SELECT data FROM session_turns').get()).toEqual({ data: row.data });
    expect(sessionTurnRevision(fixture.sqlite, row)).toBe(1);
    fixture.sqlite.transaction(() => prepareSessionTurn(fixture.sqlite, row, revised, false).commit())();
    expect(sessionTurnRevision(fixture.sqlite, row)).toBe(1);
  });

  it('does not publish canonical rows when the batch directory synchronization fails', async () => {
    const fs = await import('node:fs'), { syncBuiltinESMExports } = await import('node:module');
    const { vi } = await import('vitest'), original = fs.default.fsyncSync;
    const sync = vi.spyOn(fs.default, 'fsyncSync').mockImplementation(fd => {
      if (fs.default.fstatSync(fd).isDirectory()) throw Object.assign(new Error('directory sync failed'), { code: 'EIO' });
      original(fd);
    });
    syncBuiltinESMExports();
    try {
      expect(() => insert(turn(), false)).toThrow('directory sync failed');
      expect(fixture.sqlite.prepare('SELECT count(*) n FROM session_turns').get()).toEqual({ n: 0 });
      expect(fixture.sqlite.prepare('SELECT count(*) n FROM session_turn_payload_objects').get()).toEqual({ n: 0 });
    } finally { sync.mockRestore(); syncBuiltinESMExports(); }
  });

  it('preserves unknown fields, cleared fields, child order, empty terminals and exact noncanonical JSON', () => {
    const original = { ...turn(), terminals: [], extra: { unicode: '\ud800', unknown: ['a', null, 2] } } as TranscriptTurn;
    const row = insert(original, true);
    const changed = { ...original, items: original.items.slice(0, 1), extra: { unicode: '\udc00', unknown: [] } } as TranscriptTurn;
    fixture.sqlite.transaction(() => prepareSessionTurn(fixture.sqlite, row, changed, false).commit())();
    expect(readSessionTurn(fixture.sqlite, row)).toEqual(changed);
    const returned = { ...changed, items: [...changed.items, { ...original.items[1], rawOutput: '{ "aggregatedOutput": "other" }', outputText: undefined }] } as TranscriptTurn;
    fixture.sqlite.transaction(() => prepareSessionTurn(fixture.sqlite, row, returned, false).commit())();
    expect(readSessionTurn(fixture.sqlite, row)).toEqual({ ...returned, items: returned.items.map(item => Object.fromEntries(Object.entries(item).filter(([, v]) => v !== undefined))) });
  });

  it('preserves unknown JSON keys without assigning object prototypes', () => {
    const value = { ...turn(), ['__proto__']: { preserved: true }, storageVersion: 'provider metadata' } as TranscriptTurn;
    const row = insert(value, false);
    expect(readSessionTurn(fixture.sqlite, row)).toEqual(value);
    expect(Object.hasOwn(readSessionTurn(fixture.sqlite, row), '__proto__')).toBe(true);
  });

  it('rolls back parts and search changes with the canonical transaction', () => {
    const row = insert(turn(), true), original = readSessionTurn(fixture.sqlite, row);
    const prepared = prepareSessionTurn(fixture.sqlite, row, { ...original, outcome: { kind: 'done' } }, false);
    expect(fixture.db.connection).toBe(fixture.sqlite);
    expect(() => fixture.db.transaction(() => { prepared.commit(); throw new Error('stop'); })).toThrow('stop');
    expect(readSessionTurn(fixture.sqlite, row)).toEqual(original);
    expect(fixture.sqlite.prepare('SELECT count(*) n FROM session_turn_heads').get()).toEqual({ n: 0 });
  });

  it('rolls back a later ownership batch, retries it, and releases only replaced field owners', async () => {
    const original = turn(), row = insert(original, true);
    const revised = { ...original, items: [...original.items, ...Array.from({ length: 100 }, (_, index) => {
      const outputText = `output ${index}: ${'body'.repeat(400)}`;
      return { kind: 'execute-tool-call' as const, id: `batch-${index}`, seq: index + 3, toolCallId: `batch-${index}`,
        title: 'execute', status: 'done' as const, outputText, rawOutput: JSON.stringify({ aggregatedOutput: outputText }) };
    })] };
    const prepared = prepareSessionTurn(fixture.sqlite, row, revised, false);
    fixture.sqlite.exec(`CREATE TEMP TABLE owner_attempts(n INTEGER); INSERT INTO owner_attempts VALUES(0);
      CREATE TEMP TRIGGER fail_later_owner BEFORE INSERT ON session_turn_payload_fields BEGIN
        UPDATE owner_attempts SET n=n+1;
        SELECT CASE WHEN (SELECT n FROM owner_attempts)>70 THEN RAISE(ABORT,'later ownership batch') END;
      END;`);
    expect(() => fixture.sqlite.transaction(() => prepared.commit())()).toThrow('later ownership batch');
    expect(readSessionTurn(fixture.sqlite, row)).toEqual(original);
    expect(fixture.sqlite.prepare('SELECT count(*) n FROM session_turn_heads').get()).toEqual({ n: 0 });
    expect(fixture.sqlite.prepare('SELECT count(*) n FROM session_turn_payload_objects').get()).toEqual({ n: 0 });
    fixture.sqlite.exec('DROP TRIGGER fail_later_owner');
    // Reuse the same prepared writer after the registry transaction was rolled back.
    await withTurnPayloadWrite(fixture.sqlite, () => fixture.sqlite.transaction(() => prepared.commit())());
    expect(readSessionTurn(fixture.sqlite, row)).toEqual(revised);
    const replaced = { ...revised, items: revised.items.map(item => item.kind === 'execute-tool-call'
      ? { ...item, outputText: 'replacement'.repeat(200), rawOutput: undefined } : item) };
    await withTurnPayloadWrite(fixture.sqlite, () => fixture.sqlite.transaction(() => prepareSessionTurn(fixture.sqlite, row, replaced, false).commit())());
    while (collectTurnPayloads(fixture.sqlite)) { /* Exercise last-owner collection across multiple batches. */ }
    expect(readSessionTurn(fixture.sqlite, row)).toEqual(JSON.parse(JSON.stringify(replaced)));
    expect(fixture.sqlite.prepare(`SELECT count(*) n FROM session_turn_payload_objects o WHERE refs !=
      (SELECT count(*) FROM session_turn_payload_fields WHERE hash=o.hash)+
      (SELECT count(*) FROM session_turn_payload_edges WHERE child_hash=o.hash)+
      (SELECT count(*) FROM session_turn_payload_sources WHERE hash=o.hash)`).get()).toEqual({ n: 0 });
    expect(fixture.sqlite.pragma('foreign_key_check')).toEqual([]);
    expect(fixture.sqlite.prepare('SELECT data FROM session_turns WHERE id=?').get(row.id)).toEqual({ data: row.data });
  });

  it('registers a mix of existing and new bodies across query batches without duplicating or losing owners', async () => {
    const output = (index: number) => `shared output ${index}: ${'body'.repeat(400)}`;
    const tool = (prefix: string, index: number, text: string) => ({ kind: 'execute-tool-call' as const, id: `${prefix}-${index}`, seq: index + 3,
      toolCallId: `${prefix}-${index}`, title: 'execute', status: 'done' as const, outputText: text });
    const first = turn(), second: TranscriptTurn = { ...turn(), id: 's:turn:s1', seq: 1 };
    first.items.push(...Array.from({ length: 100 }, (_, index) => tool('first', index, output(index))));
    // 70 bodies the registry already holds and 70 new ones: both sides cross the 64-hash query boundary.
    second.items.push(...Array.from({ length: 140 }, (_, index) => tool('second', index, index < 70 ? output(index) : output(1000 + index))));
    const write = async (id: string, seq: number, value: TranscriptTurn) => {
      const prepared = prepareSessionTurn(fixture.sqlite, { id, data: JSON.stringify(value), revision: 0 }, value, true);
      await withTurnPayloadWrite(fixture.sqlite, () => fixture.sqlite.transaction(() => {
        fixture.sqlite.prepare("INSERT INTO session_turns(id,session_id,seq,turn_id,data) VALUES (?,'s',?,?,?)").run(id, seq, `runtime:${seq}`, prepared.marker);
        prepared.commit();
      })());
      return { id, data: prepared.marker };
    };
    const firstRow = await write('s:0', 0, first), secondRow = await write('s:1', 1, second);
    expect(readSessionTurn(fixture.sqlite, firstRow)).toEqual(JSON.parse(JSON.stringify(first)));
    expect(readSessionTurn(fixture.sqlite, secondRow)).toEqual(JSON.parse(JSON.stringify(second)));
    const shared = (fixture.sqlite.prepare(`SELECT count(DISTINCT hash) n FROM session_turn_payload_fields WHERE row_id='s:1'
      AND hash IN (SELECT hash FROM session_turn_payload_fields WHERE row_id='s:0')`).get() as { n: number }).n;
    expect(shared).toBeGreaterThanOrEqual(70);
    expect(fixture.sqlite.prepare(`SELECT count(*) n FROM session_turn_payload_objects o WHERE refs !=
      (SELECT count(*) FROM session_turn_payload_fields WHERE hash=o.hash)+
      (SELECT count(*) FROM session_turn_payload_edges WHERE child_hash=o.hash)+
      (SELECT count(*) FROM session_turn_payload_sources WHERE hash=o.hash)`).get()).toEqual({ n: 0 });
    expect(fixture.sqlite.pragma('foreign_key_check')).toEqual([]);
  });

  it('collects replaced bodies and rolled-back writes while keeping bodies shared by surviving fields', async () => {
    const original = turn();
    original.items.push({ ...original.items[2], id: 'shared-picture', seq: 3 });
    const row = await withTurnPayloadWrite(fixture.sqlite, () => insert(original, false));
    const initialBytes = (fixture.sqlite.prepare('SELECT sum(bytes) n FROM session_turn_payload_objects').get() as { n: number }).n;
    const storedOutput = fixture.sqlite.prepare("SELECT value FROM session_turn_fields WHERE row_id=? AND field='outputText'").get(row.id) as { value: string };
    const retired = JSON.parse(storedOutput.value) as StoredTurnValue;
    if (retired.t !== 'text') throw new Error('Expected an external output body');
    const removed = { ...original, items: [original.items[0], original.items[3]] };
    await withTurnPayloadWrite(fixture.sqlite, () => fixture.sqlite.transaction(() => prepareSessionTurn(fixture.sqlite, row, removed, false).commit())());
    while (collectTurnPayloads(fixture.sqlite)) { /* Each production batch has a fixed object/time budget. */ }
    expect(readSessionTurn(fixture.sqlite, row)).toEqual(removed);
    // The shared image survives; the unowned output object is removed from SQLite.
    expect((fixture.sqlite.prepare('SELECT sum(bytes) n FROM session_turn_payload_objects').get() as { n: number }).n).toBeLessThan(initialBytes);
    expect(() => turnPayloadFiles(fixture.sqlite).readText(retired.ref)).toThrow('Missing canonical payload object');
    const before = fixture.sqlite.prepare('SELECT hash FROM session_turn_payload_objects ORDER BY hash').all();
    await expect(withTurnPayloadWrite(fixture.sqlite, () => {
      const failed = prepareSessionTurn(fixture.sqlite, row, { ...removed, outcome: { kind: 'error', message: 'failed'.repeat(10000) } } as TranscriptTurn, false);
      fixture.sqlite.transaction(() => { failed.commit(); throw new Error('rollback'); })();
    })).rejects.toThrow('rollback');
    while (collectTurnPayloads(fixture.sqlite)) { /* Drain the bounded collector for the assertion. */ }
    expect(readSessionTurn(fixture.sqlite, row)).toEqual(removed);
    expect(fixture.sqlite.prepare('SELECT hash FROM session_turn_payload_objects ORDER BY hash').all()).toEqual(before);
    fixture.sqlite.prepare("DELETE FROM sessions WHERE id='s'").run();
    while (collectTurnPayloads(fixture.sqlite)) { /* Foreign-key cascades release the final field owners. */ }
    expect(fixture.sqlite.prepare('SELECT count(*) n FROM session_turn_payload_objects').get()).toEqual({ n: 0 });
  });

  it('keeps released bodies while another connection can still read their older SQLite snapshot', async () => {
    const original = turn(), row = await withTurnPayloadWrite(fixture.sqlite, () => insert(original, false));
    const reader = new Database(fixture.sqlite.name, { readonly: true });
    try {
      reader.exec('BEGIN');
      reader.prepare('SELECT revision FROM session_turn_heads WHERE row_id=?').get(row.id);
      const revised = { ...original, items: original.items.slice(0, 1) };
      await withTurnPayloadWrite(fixture.sqlite, () => fixture.sqlite.transaction(() => prepareSessionTurn(fixture.sqlite, row, revised, false).commit())());
      expect(collectTurnPayloads(fixture.sqlite)).toBe(0);
      expect(readSessionTurn(reader, row)).toEqual(original);
      reader.exec('COMMIT');
      while (collectTurnPayloads(fixture.sqlite)) { /* Released roots can be collected once the older reader leaves. */ }
      expect(readSessionTurn(fixture.sqlite, row)).toEqual(revised);
      expect(fixture.sqlite.prepare('SELECT count(*) n FROM session_turn_payload_objects').get()).toEqual({ n: 0 });
    } finally { reader.close(); }
  });

  it('rebuilds searchable message text from normalized history after the derived FTS rows are cleared', async () => {
    const original = turn(); insert(original, false);
    fixture.sqlite.exec("DELETE FROM turn_text_rows; DELETE FROM kv WHERE key IN ('turn_text_backfilled','turn_text_backfill_cursor')");
    await backfillTurnText(fixture.sqlite);
    expect(fixture.sqlite.prepare('SELECT text FROM turn_text_rows').all()).toEqual([{ text: 'searchable question' }]);
    expect(fixture.sqlite.prepare("SELECT count(*) n FROM turn_text WHERE turn_text MATCH 'searchable'").get()).toEqual({ n: 1 });
  });

  it('reads the same history from a database backup with its payload directory at a new location', async () => {
    const original = turn(), row = await withTurnPayloadWrite(fixture.sqlite, () => insert(original, false));
    const directory = mkdtempSync(join(tmpdir(), 'turn-copy-')), path = join(directory, 'restored.db');
    try {
      await fixture.sqlite.backup(path);
      cpSync(`${fixture.sqlite.name}.turn-payloads`, `${path}.turn-payloads`, { recursive: true });
      const restored = new Database(path, { readonly: true });
      try { expect(readSessionTurn(restored, { id: row.id })).toEqual(original); }
      finally { restored.close(); }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('preserves message multiplicity in search when only one duplicate identity is revised', () => {
    const original = turn(); original.items.push({ ...original.items[0], seq: 3 });
    const row = insert(original, false);
    const revised = { ...original, items: original.items.map((item, index) => index === 3 && item.kind === 'message' ? { ...item, text: 'revised one' } : item) };
    fixture.sqlite.transaction(() => prepareSessionTurn(fixture.sqlite, row, revised, false).commit())();
    expect(readSessionTurn(fixture.sqlite, row)).toEqual(revised);
    expect(fixture.sqlite.prepare('SELECT text FROM turn_text_rows ORDER BY text').all()).toEqual([{ text: 'revised one' }, { text: 'searchable question' }]);
  });
});
