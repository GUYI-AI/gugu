import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { withCodexNativeAuthLease } from './codex-native-auth-lease';

const roots: string[] = [];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'gugu-native-auth-lease-')); roots.push(root);
  const key = 'synthetic-native-root';
  const lock = join(root, createHash('sha256').update(key).digest('hex'));
  return { root, key, lock };
}
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

it('holds admission through the exact CLI close, then releases', async () => {
  const f = await fixture();
  await withCodexNativeAuthLease(f.root, f.key, async observer => {
    await observer.beforeSpawn();
    await observer.spawned(9911);
    expect(JSON.parse(await readFile(join(f.lock, 'owner.json'), 'utf8'))).toMatchObject({ ownerPid: process.pid, childPid: 9911, phase: 'running' });
    await observer.closed();
  });
  expect(await readdir(f.root)).toEqual([]);
});

it('a second Gugu caller cannot overlap the first operation', async () => {
  const f = await fixture();
  let entered!: () => void;
  let finish!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { finish = resolve; });
  const order: string[] = [];
  const first = withCodexNativeAuthLease(f.root, f.key, async () => { order.push('first'); entered(); await held; order.push('closed'); });
  await started;
  const second = withCodexNativeAuthLease(f.root, f.key, async () => { order.push('second'); });
  finish();
  await Promise.all([first, second]);
  expect(order).toEqual(['first', 'closed', 'second']);
});

it('an unconfirmed child stop retains ownership instead of releasing', async () => {
  const f = await fixture();
  await expect(withCodexNativeAuthLease(f.root, f.key, async observer => {
    await observer.beforeSpawn(); await observer.spawned(9911); throw new Error('stop failed');
  })).rejects.toThrow('stop failed');
  expect(JSON.parse(await readFile(join(f.lock, 'owner.json'), 'utf8'))).toMatchObject({ phase: 'running', childPid: 9911 });
});

const nonce = '00000000-0000-0000-0000-000000000001';
async function oldOwner(f: Awaited<ReturnType<typeof fixture>>, phase: 'held' | 'starting' | 'running', childPid: number | null) {
  await mkdir(f.lock);
  await writeFile(join(f.lock, 'owner.json'), JSON.stringify({ version: 1, nonce, ownerPid: 98989, phase, childPid }));
}

it('recovers a confirmed dead owner and CLI, keeping a deterministic stale receipt', async () => {
  const f = await fixture(); await oldOwner(f, 'running', 9911);
  await withCodexNativeAuthLease(f.root, f.key, async () => {}, { isAlive: () => false });
  expect(await readdir(f.root)).toEqual([`${f.lock.split('/').at(-1)}.settled-${nonce}`]);
});

it('does not take over an orphan CLI merely because its Gugu parent died', async () => {
  const f = await fixture(); await oldOwner(f, 'running', 9911);
  await expect(withCodexNativeAuthLease(f.root, f.key, async () => { throw new Error('must not enter'); }, { isAlive: pid => pid === 9911, waitMs: 0 }))
    .rejects.toThrow('still owned');
  expect(JSON.parse(await readFile(join(f.lock, 'owner.json'), 'utf8')).nonce).toBe(nonce);
});

it('keeps an unknown spawn outcome pending without a TTL-based retry', async () => {
  const f = await fixture(); await oldOwner(f, 'starting', null);
  await expect(withCodexNativeAuthLease(f.root, f.key, async () => {}, { isAlive: () => false, waitMs: 0 })).rejects.toThrow('unknown outcome');
  expect(JSON.parse(await readFile(join(f.lock, 'owner.json'), 'utf8')).nonce).toBe(nonce);
});
