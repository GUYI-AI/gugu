import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, opendir, writeFile, rm } from 'node:fs/promises';
import type { Dir, Dirent } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createWindowBudget } from '@gugu/session-core/session-record/window-cache/read-budget';
import { prepareWindowCommitDirectory } from './window-commit-directory';
import { openWindowCommitPins } from './window-commit-pins';
import { createWindowCommitGcDiscovery } from './window-commit-gc-discovery';

const paths: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const path of paths.splice(0)) await rm(path, { recursive: true, force: true }); });
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'gc-discovery-')); paths.push(directory);
  const scope = 'a'.repeat(64), path = join(directory, 'source-versions', scope);
  await prepareWindowCommitDirectory(directory, ['source-versions', scope]);
  const pins = await openWindowCommitPins({ directory, proof: { namespace: directory, assertHeld() {} },
    receipts: { bySource: () => null, byRow: () => null }, canCollect: async () => true });
  const discovery = createWindowCommitGcDiscovery({ directory, scope, pins });
  return { directory, scope, path, pins, discovery };
}

describe('incremental source catalog candidate discovery', () => {
  it('admits at most 64 actual directory reads per batch and continues through a large metadata-only prefix', async () => {
    const f = await fixture(), id = randomUUID();
    for (let i = 0; i < 150; i++) await writeFile(join(f.path, `${randomUUID()}.version.tmp`), '');
    const handle = await opendir(f.path, { bufferSize: 1 }), proto = Object.getPrototypeOf(handle) as Dir, read = proto.read; await handle.close();
    let reads = 0;
    vi.spyOn(proto, 'read').mockImplementation((async function(this: Dir) { reads++; return Reflect.apply(read, this, []); }) as typeof read);
    const first = createWindowBudget(); expect(await f.discovery.next(first)).toEqual({ kind: 'continuation' });
    expect(reads).toBeGreaterThan(0); expect(reads).toBeLessThanOrEqual(64);
    await writeFile(join(f.path, `${id}.version`), 'bounded metadata is read separately');
    let found = false;
    for (let i = 0; i < 160; i++) {
      const before = reads, budget = createWindowBudget(), result = await f.discovery.next(budget);
      expect(reads - before).toBeLessThanOrEqual(64); expect(budget.counters.examinedRecords).toBe(reads - before);
      expect(budget.counters.sourceBytes).toBe(0);
      if (result.kind === 'candidate') { expect(result.sourceId).toBe(id); found = true; break; }
      expect(['continuation', 'end']).toContain(result.kind);
    }
    expect(found).toBe(true); await f.discovery.close();
  });

  it('reopens after a terminal pass so a newly created version is not permanently absent', async () => {
    const f = await fixture(); expect(await f.discovery.next(createWindowBudget())).toEqual({ kind: 'end' });
    const id = randomUUID(); await writeFile(join(f.path, `${id}.version`), 'metadata');
    expect(await f.discovery.next(createWindowBudget())).toEqual({ kind: 'candidate', sourceId: id }); await f.discovery.close();
  });

  it('retains one actually read candidate on cancellation and closes its native directory handle', async () => {
    const f = await fixture(), id = randomUUID(); await writeFile(join(f.path, `${id}.version`), 'metadata');
    const dir = await opendir(f.path), proto = Object.getPrototypeOf(dir) as Dir, read = proto.read; await dir.close();
    const abort = new AbortController(), handles: Dir[] = [];
    vi.spyOn(proto, 'read').mockImplementation((async function(this: Dir) {
      handles.push(this); const entry = await Reflect.apply(read, this, []) as Dirent | null;
      if (entry?.name === `${id}.version`) abort.abort(); return entry;
    }) as typeof read);
    const budget = createWindowBudget(); await expect(f.discovery.next(budget, abort.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(budget.counters.examinedRecords).toBeGreaterThan(0); await expect(handles[0].read()).rejects.toMatchObject({ code: 'ERR_DIR_CLOSED' });
    vi.restoreAllMocks(); expect(await f.discovery.next(createWindowBudget())).toEqual({ kind: 'candidate', sourceId: id }); await f.discovery.close();
  });

  it('serializes concurrent discovery and permanently closes its own handle on disposal', async () => {
    const f = await fixture(), ids = [randomUUID(), randomUUID()];
    for (const id of ids) await writeFile(join(f.path, `${id}.version`), 'metadata');
    const results = await Promise.all([f.discovery.next(createWindowBudget()), f.discovery.next(createWindowBudget())]);
    expect(results.map(value => value.kind === 'candidate' ? value.sourceId : '').sort()).toEqual(ids.sort());
    await f.discovery.close(); await expect(f.discovery.next(createWindowBudget())).rejects.toThrow('closed');
  });
});
