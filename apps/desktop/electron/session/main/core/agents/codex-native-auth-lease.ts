import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

type Owner = { version: 1; nonce: string; ownerPid: number; phase: 'held' | 'starting' | 'running'; childPid: number | null };
export type CodexAuthProcessObserver = {
  beforeSpawn(): Promise<void>;
  spawned(pid: number): Promise<void>;
  closed(): Promise<void>;
};

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}

function ownerFrom(value: unknown): Owner | null {
  const item = value as Partial<Owner> | null;
  return item?.version === 1 && typeof item.nonce === 'string' && /^[a-f0-9-]{36}$/.test(item.nonce)
    && Number.isInteger(item.ownerPid) && item.ownerPid! > 0
    && ['held', 'starting', 'running'].includes(item.phase ?? '')
    && (item.childPid === null || Number.isInteger(item.childPid) && item.childPid! > 0)
    ? item as Owner : null;
}

/**
 * Shared by Gugu profiles, outside the user's Codex directory. No TTL takeover:
 * a surviving CLI (or an unrecorded spawn after a host crash) must not overlap a new refresh.
 */
export async function withCodexNativeAuthLease<T>(
  root: string,
  sourceKey: string,
  work: (observer: CodexAuthProcessObserver) => Promise<T>,
  options: { isAlive?: (pid: number) => boolean; waitMs?: number; signal?: AbortSignal } = {},
): Promise<T> {
  const isAlive = options.isAlive ?? alive;
  await mkdir(root, { recursive: true, mode: 0o700 });
  const lock = join(root, createHash('sha256').update(sourceKey).digest('hex'));
  const ownerFile = join(lock, 'owner.json');
  const deadline = Date.now() + (options.waitMs ?? 60_000);
  const owner: Owner = { version: 1, nonce: randomUUID(), ownerPid: process.pid, phase: 'held', childPid: null };
  for (;;) {
    options.signal?.throwIfAborted();
    try { await mkdir(lock, { mode: 0o700 }); break; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    let previous: Owner | null = null;
    try { previous = ownerFrom(JSON.parse(await readFile(ownerFile, 'utf8'))); }
    catch (error) {
      // mkdir precedes the first owner write; allow that live publisher to finish, never delete it.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Codex native refresh ownership is unreadable; retry after its owner settles');
    }
    if (previous && !isAlive(previous.ownerPid)) {
      if (previous.phase === 'starting' && previous.childPid === null) {
        throw new Error('Codex native refresh spawn has an unknown outcome; another refresh was not started');
      }
      if (previous.childPid === null || !isAlive(previous.childPid)) {
        // A deterministic nonempty tombstone prevents a second stale observer from renaming a NEW lock.
        // Keep this tiny receipt: deleting it would reopen the stale-observer rename race.
        const stale = `${lock}.settled-${previous.nonce}`;
        try { await rename(lock, stale); }
        catch (error) {
          if (!['ENOENT', 'EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
        }
        continue;
      }
    }
    if (Date.now() >= deadline) throw new Error('Codex native refresh is still owned by another process; retry after it finishes');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  const persist = async () => {
    const temporary = join(lock, `${owner.nonce}.tmp`);
    await writeFile(temporary, JSON.stringify(owner), { mode: 0o600 });
    await rename(temporary, ownerFile);
  };
  await persist();
  const observer: CodexAuthProcessObserver = {
    beforeSpawn: async () => { owner.phase = 'starting'; owner.childPid = null; await persist(); },
    spawned: async pid => {
      if (!Number.isInteger(pid) || pid <= 0) throw new Error('Codex native refresh did not provide its child PID');
      owner.phase = 'running'; owner.childPid = pid; await persist();
    },
    closed: async () => { owner.phase = 'held'; owner.childPid = null; await persist(); },
  };
  let outcome: { value: T } | { error: unknown };
  try { options.signal?.throwIfAborted(); outcome = { value: await work(observer) }; }
  catch (error) { outcome = { error }; }
  try {
    // Only closed/never-spawned work can release. Stop failure leaves the exact owner/child receipt.
    if (owner.phase === 'held') {
      const current = ownerFrom(JSON.parse(await readFile(ownerFile, 'utf8')));
      if (current?.nonce !== owner.nonce) throw new Error('Codex native refresh ownership changed before release');
      const settled = `${lock}.closed-${owner.nonce}`;
      await rename(lock, settled);
      await rm(settled, { recursive: true });
    }
  } catch (releaseError) {
    if ('error' in outcome) {
      // Keep the operation as the primary cause (including revoked-auth classification),
      // while retaining the cleanup failure instead of replacing or silently dropping either.
      throw new AggregateError([outcome.error, releaseError],
        outcome.error instanceof Error ? outcome.error.message : 'Native Codex auth operation failed', { cause: outcome.error });
    }
    throw releaseError;
  }
  if ('error' in outcome) throw outcome.error;
  return outcome.value;
}
