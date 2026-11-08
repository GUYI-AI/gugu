import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, open, rm, stat, type FileHandle } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { readWindowFrame as readLegacy, writeWindowFrame as writeLegacy } from '@gugu/session-core/session-record/window-cache/disk-frame';
import { createWindowBudget } from '@gugu/session-core/session-record/window-cache/read-budget';
import { assertWindowCommitSource, writeWindowCommitSource } from './window-commit-source';
import { readWindowFrame as read, writeWindowFrame as write, windowCommitProjectionDirectory } from './window-commit-projection-disk';

const owned: string[] = [], binding = { scope: 'a'.repeat(64), sourceLineage: 'b'.repeat(64), decoderVersion: 1 };
const key = { ...binding, kind: 'projection' as const, cursor: 'test:entity' };
afterEach(async () => { vi.restoreAllMocks(); for (const path of owned.splice(0)) await rm(path, { recursive: true, force: true }); });
async function directory() { const path = await mkdtemp(join(tmpdir(), 'projection-version-')); owned.push(path); return path; }

describe('independently reclaimable projection namespaces', () => {
  it('rebuilds beside a legacy flat projection without moving its receipt-bound immutable source', async () => {
    const path = await directory(), source = await writeWindowCommitSource(path, binding, '{"text":"正文"}');
    await writeLegacy(path, key, Buffer.from('old version'));
    expect(await read(path, key, createWindowBudget())).toMatchObject({ kind: 'miss', reason: 'not_found' });
    await write(path, key, Buffer.from('rebuilt version'));
    expect(await read(path, key, createWindowBudget())).toMatchObject({ kind: 'hit', bytes: Buffer.from('rebuilt version') });
    expect(await readLegacy(path, key, createWindowBudget())).toMatchObject({ kind: 'hit', bytes: Buffer.from('old version') });
    await assertWindowCommitSource(path, binding, source);
    await rm(windowCommitProjectionDirectory(path, binding), { recursive: true });
    await assertWindowCommitSource(path, binding, source);
    expect(await read(path, key, createWindowBudget())).toMatchObject({ kind: 'miss', reason: 'not_found' });
  });

  it('isolates source and scope versions, preserving immutable conflicts and point-read budgets', async () => {
    const path = await directory(), next = { ...key, sourceLineage: 'c'.repeat(64) }, other = { ...key, scope: 'd'.repeat(64) };
    await Promise.all([write(path, key, Buffer.from('first')), write(path, next, Buffer.from('next')), write(path, other, Buffer.from('other'))]);
    await expect(write(path, key, Buffer.from('overwrite'))).rejects.toMatchObject({ code: 'EEXIST' });
    for (const [frame, text] of [[key, 'first'], [next, 'next'], [other, 'other']] as const) {
      const budget = createWindowBudget(); expect(await read(path, frame, budget)).toMatchObject({ kind: 'hit', bytes: Buffer.from(text) });
      expect(budget.counters.indexBytes).toBeGreaterThan(0); expect(budget.counters.indexBytes).toBeLessThan(4096);
      expect(budget.counters.sourceBytes).toBe(0);
    }
  });

  it('syncs namespace parents before the first frame, and retries initialization after an actual directory sync failure', async () => {
    const path = await directory(), target = windowCommitProjectionDirectory(path, binding);
    const parents = [target, dirname(target), dirname(dirname(target)), path], order: string[] = [];
    const file = await open(path, 'r'), proto = Object.getPrototypeOf(file) as FileHandle, sync = proto.sync; await file.close();
    let fail = true;
    vi.spyOn(proto, 'sync').mockImplementation(async function(this: FileHandle) {
      const observed = await this.stat({ bigint: true });
      if (observed.isDirectory()) {
        const current = await Promise.all(parents.map(async name => ({ name, value: await stat(name, { bigint: true }) })));
        order.push(current.find(value => value.value.ino === observed.ino && value.value.dev === observed.dev)!.name);
        if (fail) { fail = false; throw new Error('namespace sync failed'); }
      } else order.push('frame');
      await sync.call(this);
    });
    await expect(write(path, key, Buffer.from('content'))).rejects.toThrow('namespace sync failed');
    expect(await read(path, key, createWindowBudget())).toMatchObject({ kind: 'miss', reason: 'not_found' });
    order.length = 0; await write(path, key, Buffer.from('content'));
    for (const parent of parents) { expect(order).toContain(parent); expect(order.indexOf(parent)).toBeLessThan(order.indexOf('frame')); }
    expect(await read(path, key, createWindowBudget())).toMatchObject({ kind: 'hit', bytes: Buffer.from('content') });
  });
});
