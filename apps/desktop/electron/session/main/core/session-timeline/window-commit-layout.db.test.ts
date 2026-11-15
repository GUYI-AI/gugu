import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { openFixture } from '@tooling/utils/db';
import type { AppDb } from '@main/db/client';
import { createWindowCommitReceipts } from './window-commit-receipt';
import { createWindowPackStore } from './window-pack-store';
import { writeWindowFrame } from './window-commit-projection-disk';
import { prepareWindowCommitLayout, WINDOW_COMMIT_LAYOUT_MARKER, WINDOW_COMMIT_LAYOUT_TABLES, WINDOW_COMMIT_LAYOUT_VERSION } from './window-commit-layout';

const state = vi.hoisted(() => ({ db: undefined as AppDb | undefined, sqlite: undefined as Database.Database | undefined }));
vi.mock('@main/db/client', () => ({ get db() { return state.db; }, get sqlite() { return state.sqlite; } }));
vi.mock('@main/lib/events', () => ({ events: { emit: vi.fn() } }));
import { persistCommittedTurn } from '../sessions/session-turn-store';

const proof = { assertHeld() {} };
describe('committed cache layout marker', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>, root: string, directory: string;
  beforeEach(async () => {
    fixture = await openFixture('empty'); state.db = fixture.db; state.sqlite = fixture.sqlite;
    fixture.sqlite.exec("INSERT INTO projects(id,name,path) VALUES('p','P','/fixture'); INSERT INTO sessions(id,project_id) VALUES('c','p')");
    root = await mkdtemp(join(tmpdir(), 'commit-layout-')); directory = join(root, 'committed');
  });
  afterEach(async () => { vi.restoreAllMocks(); fixture?.close(); state.db = undefined; state.sqlite = undefined; await rm(root, { recursive: true, force: true }); });
  const prepare = (observed?: (phase: 'files' | 'tables') => void) => prepareWindowCommitLayout({ directory, connection: fixture.sqlite, proof, observed });
  const marker = async () => JSON.parse(await readFile(join(directory, WINDOW_COMMIT_LAYOUT_MARKER), 'utf8'));
  const counts = () => Object.fromEntries(WINDOW_COMMIT_LAYOUT_TABLES.map(table =>
    [table, (fixture.sqlite.prepare(`SELECT count(*) n FROM ${table}`).get() as { n: number }).n]));
  const canonical = () => ({
    turns: fixture.sqlite.prepare('SELECT * FROM session_turns ORDER BY id').all(),
    sessions: fixture.sqlite.prepare('SELECT * FROM sessions ORDER BY id').all(),
  });
  /** A development build's cache: receipt + raw source + catalog, a packed
   * projection, a pre-pack namespace projection directory and stray files. */
  async function developmentCache(extra = 0) {
    await mkdir(directory, { recursive: true });
    let committed: Parameters<NonNullable<Parameters<typeof persistCommittedTurn>[0]['windowCapture']>['committed']>[0] = null;
    await persistCommittedTurn({ sessionId: 'c', source: 'live', turn: { id: 't', seq: 0, referenceId: 'ref', initiator: 'user', outcome: { kind: 'done' },
      items: [{ kind: 'message', id: 'm', seq: 0, role: 'assistant', text: 'canonical body' }] },
      windowCapture: { directory, scope: 'a'.repeat(64), cursor: { workerEpoch: 'w', storeEpoch: 's', sequence: 1 }, committed: async r => { committed = r; } } });
    const receipt = createWindowCommitReceipts(fixture.sqlite).byReference('c', 'ref')!;
    expect(committed).toEqual(receipt);
    const store = createWindowPackStore(directory, fixture.sqlite);
    await store.build([receipt], () => writeWindowFrame(directory, { ...receipt.binding, kind: 'projection', cursor: 'page' }, Buffer.from('packed')));
    store.close();
    const legacy = join(directory, 'projection-versions', 'b'.repeat(64), `${'c'.repeat(64)}-1`);
    await mkdir(legacy, { recursive: true }); await writeFile(join(legacy, `${'d'.repeat(64)}.frame`), 'pre-pack');
    for (let i = 0; i < extra; i++) await writeFile(join(directory, `${String(i).padStart(64, '0')}.frame`), 'stray');
    await writeFile(join(directory, `${WINDOW_COMMIT_LAYOUT_MARKER}.tmp`), 'interrupted marker');
  }

  it('writes the versioned marker directly on a fresh install', async () => {
    expect(await prepare()).toBe('cleared');
    expect(await readdir(directory)).toEqual([WINDOW_COMMIT_LAYOUT_MARKER]);
    expect(await marker()).toEqual({ version: WINDOW_COMMIT_LAYOUT_VERSION });
    expect(await prepare()).toBe('current');
  });

  it('clears every development-era file and cache table row but no canonical row', async () => {
    await developmentCache(); const before = canonical();
    expect(before.turns).toHaveLength(1);
    expect((await readdir(directory)).some(name => name.endsWith('.pack'))).toBe(true);
    expect((await readdir(directory)).some(name => name.endsWith('.source'))).toBe(true);
    expect(await readdir(directory)).toEqual(expect.arrayContaining(['source-versions', 'projection-versions']));
    expect(Object.values(counts()).some(n => n > 0)).toBe(true);
    expect(await prepare()).toBe('cleared');
    expect(await readdir(directory)).toEqual([WINDOW_COMMIT_LAYOUT_MARKER]);
    expect(Object.values(counts()).every(n => n === 0)).toBe(true);
    expect(canonical()).toEqual(before);
  });

  it('resumes clearing after a crash midway and writes the marker only when done', async () => {
    await developmentCache(200); const before = canonical();
    await expect(prepare(phase => { if (phase === 'files') throw new Error('crashed while clearing'); })).rejects.toThrow('crashed');
    const left = await readdir(directory);
    expect(left).not.toContain(WINDOW_COMMIT_LAYOUT_MARKER); expect(left.length).toBeGreaterThan(1);
    expect(await prepare()).toBe('cleared');
    expect(await readdir(directory)).toEqual([WINDOW_COMMIT_LAYOUT_MARKER]);
    expect(Object.values(counts()).every(n => n === 0)).toBe(true); expect(canonical()).toEqual(before);
  });

  it('resumes after a crash between the files and the cache tables', async () => {
    await developmentCache(); const before = canonical();
    await expect(prepare(phase => { if (phase === 'tables') throw new Error('crashed in tables'); })).rejects.toThrow('crashed');
    await expect(readFile(join(directory, WINDOW_COMMIT_LAYOUT_MARKER))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await prepare()).toBe('cleared');
    expect(Object.values(counts()).every(n => n === 0)).toBe(true); expect(canonical()).toEqual(before);
  });

  it('clears a cache whose marker carries an older layout version and keeps a current one', async () => {
    await developmentCache();
    await writeFile(join(directory, WINDOW_COMMIT_LAYOUT_MARKER), JSON.stringify({ version: WINDOW_COMMIT_LAYOUT_VERSION - 1 }));
    expect(await prepare()).toBe('cleared');
    expect(await marker()).toEqual({ version: WINDOW_COMMIT_LAYOUT_VERSION });
    await writeFile(join(directory, 'kept.frame'), 'written under the current layout');
    expect(await prepare()).toBe('current');
    expect(await readdir(directory)).toContain('kept.frame');
  });

  it('leaves entries outside its fixed scope untouched', async () => {
    await developmentCache();
    await mkdir(join(directory, 'guards')); await writeFile(join(directory, 'guards', 'lock.sqlite'), 'foreign');
    await writeFile(join(directory, 'notes.txt'), 'foreign');
    expect(await prepare()).toBe('cleared');
    expect((await readdir(directory)).sort()).toEqual([WINDOW_COMMIT_LAYOUT_MARKER, 'guards', 'notes.txt'].sort());
    expect(await readdir(join(directory, 'guards'))).toEqual(['lock.sqlite']);
  });

  it('stops before removing anything once the gateway proof is lost', async () => {
    await developmentCache(); const names = await readdir(directory);
    const lost = { assertHeld() { throw Object.assign(new Error('lost'), { code: 'needs_location' }); } };
    await expect(prepareWindowCommitLayout({ directory, connection: fixture.sqlite, proof: lost })).rejects.toThrow('lost');
    expect(await readdir(directory)).toEqual(names);
  });
});
