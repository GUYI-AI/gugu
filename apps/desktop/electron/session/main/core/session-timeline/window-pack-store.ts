import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import { link, open, opendir, rm, type FileHandle } from 'node:fs/promises';
import type { Dir } from 'node:fs';
import { join } from 'node:path';
import { registerWindowFrameBackend, windowFrameBackend, type WindowFrameBackend } from '@gugu/session-core/session-record/window-cache/frame-backend';
import { decodeWindowFrame, windowFrameName, type WindowFrameKey, type WindowFrameRead } from '@gugu/session-core/session-record/window-cache/frame';
import type { WindowBudget } from '@gugu/session-core/session-record/window-cache/types';
import { syncWindowDirectory } from '@gugu/session-core/session-record/window-cache/disk-frame';
import { createWindowPackIndex, type PackPhysical, type PackFrame, type PackLocation } from './window-pack-index';
import { createWindowCommitReceipts, snapshotWindowCommitReceipt, type WindowReceiptDatabase, type WindowCommitReceipt } from './window-commit-receipt';

const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function identity(s: { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint }): PackPhysical {
  return { dev: String(s.dev), ino: String(s.ino), size: String(s.size), mtimeNs: String(s.mtimeNs), ctimeNs: String(s.ctimeNs) };
}
const same = (a: PackPhysical, b: PackPhysical) => JSON.stringify(a) === JSON.stringify(b);
const fault = (message: string) => Object.assign(new Error(message), { code: 'needs_location' });
type Group = { id: string; file?: FileHandle; bytes: number; writes: number; frames: Map<string, PackFrame>; dependencies: Map<string, PackLocation> };
/** `packs` holds one position per pack this build has committed or read: the
 * build's own earlier progress packs and every pack they depended on. */
type Build = { sources: WindowCommitReceipt[]; group?: Group; packs: Map<string, PackLocation>; closed: boolean };
/** A publication proves every pack of its build with one bounded stat each. */
export const WINDOW_PACK_DEPENDENCIES = 128;
/** A build that would need more packs than one bounded proof covers. The
 * publisher splits merged builds on it; a single turn that still exceeds it is
 * reported for that turn alone. */
const capacity = () => Object.assign(fault('Projection build exceeds its bounded pack proof'), { reason: 'pack_capacity' as const });
export const isWindowPackCapacityFault = (error: unknown) =>
  (error as { code?: unknown; reason?: unknown } | null)?.code === 'needs_location' && (error as { reason?: unknown }).reason === 'pack_capacity';
const proofs = new WeakMap<WindowFrameBackend, (name: string) => () => void>();
/** Bounded proof for one committed frame of the pack store that owns `directory`.
 * Without an owning store there is no packed version to prove. */
export function windowPackProof(directory: string, key: WindowFrameKey): () => void {
  const backend = windowFrameBackend(directory), proof = backend && proofs.get(backend);
  if (!proof) throw fault('Projection pack store is unavailable');
  return proof(windowFrameName(key));
}
export type WindowPackObserver = (phase: 'intent' | 'pack_synced' | 'directory_synced' | 'positions_committed', groupId: string) => void;

/** One application gateway and a task-local private view. External readers only
 * see offsets published by the SQLite group transaction. Pack bodies never enter
 * a Map; it holds at most 128 scalar positions and one encoded frame at a time. */
export function createWindowPackStore(directory: string, db: WindowReceiptDatabase, observed?: WindowPackObserver,
  limits: { packs: number } = { packs: WINDOW_PACK_DEPENDENCIES }) {
  if (!Number.isSafeInteger(limits.packs) || limits.packs < 2 || limits.packs > WINDOW_PACK_DEPENDENCIES) throw new Error('Invalid pack build capacity');
  const receipts = createWindowCommitReceipts(db), index = createWindowPackIndex(db, receipts.bySource);
  const local = new AsyncLocalStorage<Build>(), active = new Set<Build>(); let closed = false;
  const path = (id: string) => join(directory, `${id}.pack`);
  function selected() {
    const build = local.getStore();
    if (closed || !build || build.closed || !active.has(build)) throw new Error('Frame write has no active pack group');
    return build;
  }
  async function start(build: Build) {
    // A build whose packs no longer fit one bounded proof cannot be published.
    if (build.packs.size >= limits.packs) throw capacity();
    const id = randomUUID().replaceAll('-', ''); index.begin(id,build.sources);
    const group: Group = { id, bytes: 0, writes: 0, frames: new Map(), dependencies: new Map(build.packs) }; build.group = group;
    observed?.('intent',id);
    group.file = await open(`${path(id)}.tmp`,'wx+',0o600); return group;
  }
  async function flush(build: Build) {
    const group = build.group; if (!group) return;
    if (!group.file) throw new Error('Cannot publish an unopened pack');
    if (!group.writes) { await group.file.close(); group.file = undefined; index.abandon(group.id);
      await rm(`${path(group.id)}.tmp`,{ force: true }); build.group = undefined; return; }
    await group.file.sync(); observed?.('pack_synced',group.id);
    await group.file.close(); group.file = undefined;
    await link(`${path(group.id)}.tmp`,path(group.id)); await rm(`${path(group.id)}.tmp`);
    await syncWindowDirectory(directory); observed?.('directory_synced',group.id);
    const stat = statSync(path(group.id),{ bigint: true });
    if (!stat.isFile() || stat.size !== BigInt(group.bytes)) throw fault('Pack changed before publication');
    // No await between final physical/dependency/receipt proof and the atomic index commit.
    for (const dependency of group.dependencies.values()) {
      const saved = statSync(path(dependency.groupId),{ bigint: true });
      if (!saved.isFile() || !same(identity(saved),dependency.physical)) throw fault('Pack dependency physical identity changed');
    }
    index.complete(group.id,identity(stat),build.sources,[...group.frames.values()],[...group.dependencies.values()]);
    // Every later pack of this build directly depends on this one and on what it
    // read, so the final publication's direct dependencies cover the whole build.
    const last=[...group.frames.values()].at(-1)!, committed=index.lookup(group.id,last.name);
    if (!committed) throw fault('Pack position changed after publication');
    for (const [key,value] of group.dependencies) build.packs.set(key,value);
    build.packs.set(group.id,committed);
    build.group = undefined; observed?.('positions_committed',group.id);
  }
  async function readPacket(file: FileHandle, location: PackFrame, budget: WindowBudget) {
    let packet = new Uint8Array(0), used = 0, failure: unknown;
    await budget.read('indexBytes',location.length,async () => {
      packet = new Uint8Array(location.length);
      try { while (used < packet.length) {
        const { bytesRead } = await file.read(packet,used,packet.length-used,location.offset+used);
        if (!bytesRead) break; used += bytesRead;
      } } catch (error) { failure = error; }
      return used;
    });
    if (failure) throw failure;
    if (used !== packet.length || hash(packet) !== location.sha256) throw fault('Pack frame is truncated or corrupted');
    return packet;
  }
  async function read(key: WindowFrameKey, budget: WindowBudget): Promise<WindowFrameRead> {
    if (closed) throw fault('Pack store has been released');
    const name = windowFrameName(key), build = local.getStore();
    const own = build && !build.closed && build.group?.frames.get(name);
    if (own && build?.group?.file) return decodeWindowFrame(key,await readPacket(build.group.file,own,budget));
    const location = index.current(name); if (!location) return { kind: 'miss', reason: 'not_found' };
    const file = await open(path(location.groupId),'r').catch(()=>{throw fault('Committed pack file is unavailable');});
    try {
      const before = await file.stat({ bigint: true });
      if (!before.isFile() || !same(identity(before),location.physical)) throw fault('Pack physical identity changed');
      const packet = await readPacket(file,location,budget), after = await file.stat({ bigint: true });
      if (closed || !same(identity(after),location.physical)) throw fault('Pack changed during point read');
      const current = index.lookup(location.groupId,name);
      if (!current || JSON.stringify(current) !== JSON.stringify(location)) throw fault('Pack receipt or position changed during read');
      if (build && !build.closed) {
        if (!build.group) await start(build);
        const dependencies = build.group!.dependencies, dependencyKey = location.groupId;
        if (!dependencies.has(dependencyKey) && dependencies.size >= limits.packs) { await flush(build); await start(build); }
        build.group!.dependencies.set(dependencyKey,location);
      }
      return decodeWindowFrame(key,packet);
    } finally { await file.close(); }
  }
  const backend: WindowFrameBackend = { read, async write(key, packet) {
    const build = selected(), name = windowFrameName(key);
    const source = build.sources.find(s => s.binding.scope === key.scope && s.binding.sourceLineage === key.sourceLineage
      && s.binding.decoderVersion === key.decoderVersion);
    if (!source) throw new Error('Frame belongs to another pack conversation/source');
    if (key.kind !== 'head' && (build.group?.frames.has(name) || index.current(name)))
      throw Object.assign(new Error('Immutable pack frame exists'), { code: 'EEXIST' });
    let group = build.group ?? await start(build);
    if (group.writes >= 128 || group.bytes + packet.length > 4*1024*1024) { await flush(build); group = await start(build); }
    let used = 0;
    while (used < packet.length) {
      const { bytesWritten } = await group.file!.write(packet,used,packet.length-used,group.bytes+used);
      if (!bytesWritten) throw new Error('Pack write made no progress'); used += bytesWritten;
    }
    group.frames.set(name,{ groupId: group.id, name, sourceId: source.sourceId, offset: group.bytes, length: packet.length, sha256: hash(packet) });
    group.bytes += packet.length; group.writes++;
  } };
  const unregister = registerWindowFrameBackend(directory,backend);
  /** Bounded: the publication pack plus its at most 128 direct dependencies,
   * which include every earlier pack of the same build. No recursive walk. */
  function proof(name: string) {
      const location=index.current(name);if(!location)throw fault('Packed publication has no committed location');
      const dependencies=index.dependencies(location.groupId,WINDOW_PACK_DEPENDENCIES);
      return ()=>{
        const current=index.lookup(location.groupId,name);
        if(!current||JSON.stringify(current)!==JSON.stringify(location))throw fault('Packed publication lost its canonical position');
        for(const pack of [location,...dependencies]){
          const held=index.lookup(pack.groupId,pack.name);
          if(!held||JSON.stringify(held)!==JSON.stringify(pack))throw fault('Packed publication dependency lost its canonical position');
          try{const physical=statSync(path(pack.groupId),{bigint:true});
            if(!physical.isFile()||!same(identity(physical),pack.physical))throw fault('Packed publication physical identity changed');
          }catch{throw fault('Packed publication physical identity changed');}
        }
      };
  }
  proofs.set(backend,proof);
  return {
    proof,
    /** Packs the calling build has committed or depends on, plus its open one. */
    used() { const build = selected(); return build.packs.size + (build.group ? 1 : 0); },
    capacity: limits.packs,
    backend, // Keep the weak namespace registration alive for this owner.
    /** Invocations are independent. The dispatcher chooses at most eight same-
     * conversation receipts; a giant build emits bounded progress packs. */
    async build<T>(sources: readonly WindowCommitReceipt[], run: () => Promise<T>): Promise<T> {
      if (closed || active.size >= 32) throw new Error('Pack store is closed or occupied');
      const saved = sources.map(snapshotWindowCommitReceipt);
      if (saved.length < 1 || saved.length > 8 || saved.some(s => s.sessionId !== saved[0].sessionId)
        || [...active].some(b => b.sources.some(s => saved.some(v => v.sourceId === s.sourceId)))) throw new Error('Pack sources are occupied or invalid');
      const build: Build = { sources: saved, packs: new Map(), closed: false }; active.add(build);
      try { return await local.run(build,async () => {
        const result = await run(); await flush(build); return result;
      }); } finally { build.closed = true; active.delete(build); await build.group?.file?.close(); }
    },
    /** One bounded recovery page. Only names derived from an owned intent are
     * removed; canonical data is never parsed and complete groups stay intact. */
    async recover(after = '') {
      const page = index.recovery(after);
      for (const row of page) {
        if ([...active].some(b => b.group?.id === row.groupId)) throw new Error('Cannot recover an active pack');
        index.abandon(row.groupId);
        await rm(`${path(row.groupId)}.tmp`,{ force: true }); await rm(path(row.groupId),{ force: true });
        await syncWindowDirectory(directory);index.forget(row.groupId);
      }
      return { anchors: page.map(row => ({ groupId: row.groupId, sources: row.sources })), next: page.length === 8 ? page[7].groupId : null };
    },
    close() { if (active.size) throw new Error('Flush admitted pack jobs before releasing their store'); closed = true; unregister(); },
  };
}

/** Reclaim committed packs that no frame references any more (their receipts
 * were collected or cascaded away). At most `limit` packs per call; the file is
 * removed and synced before its row, so a crash leaves only a row whose file is
 * already gone, which the next sweep removes. Complete groups never gain frames. */
export async function sweepWindowPackGroups(directory: string, db: WindowReceiptDatabase, proof: { assertHeld(): void }, limit = 8): Promise<number> {
  proof.assertHeld();
  const orphaned = `SELECT group_id FROM session_window_pack_groups g WHERE g.state='complete'
    AND NOT EXISTS (SELECT 1 FROM session_window_pack_frames f WHERE f.group_id=g.group_id)`;
  const rows = db.prepare(`${orphaned} LIMIT ?`).all(limit) as { group_id: string }[];
  if (!rows.length) return 0;
  for (const row of rows) {
    if (!/^[a-f0-9]{32}$/.test(row.group_id)) throw new Error('Invalid pack group');
    proof.assertHeld(); await rm(join(directory, `${row.group_id}.pack`), { force: true });
  }
  proof.assertHeld(); await syncWindowDirectory(directory); proof.assertHeld();
  const remove = db.prepare(`DELETE FROM session_window_pack_groups WHERE group_id=? AND group_id IN (${orphaned})`);
  for (const row of rows) remove.run(row.group_id);
  return rows.length;
}

/** Packs whose group row is gone: deleting a session cascades its group rows
 * immediately, leaving the files. Walks the namespace with one handle across
 * calls, examining at most `limit` entries per call, and removes `<group>.pack`
 * or `<group>.pack.tmp` only when no group row (in any state) exists. A build
 * always inserts its row before creating either file. */
export function createWindowPackFileSweeper(directory: string, db: WindowReceiptDatabase) {
  let handle: Dir | undefined;
  const known = db.prepare('SELECT 1 FROM session_window_pack_groups WHERE group_id=?');
  return {
    async step(proof: { assertHeld(): void }, limit = 64): Promise<'more' | 'end'> {
      proof.assertHeld();
      handle ??= await opendir(directory, { bufferSize: 1 });
      let removed = false;
      try {
        for (let examined = 0; examined < limit; examined++) {
          const entry = await handle.read();
          if (!entry) { const done = handle; handle = undefined; await done.close(); if (removed) await syncWindowDirectory(directory); return 'end'; }
          const match = /^([a-f0-9]{32})\.pack(?:\.tmp)?$/.exec(entry.name);
          if (!match || !entry.isFile() || known.get(match[1])) continue;
          proof.assertHeld(); await rm(join(directory, entry.name), { force: true }); removed = true;
        }
      } catch (error) { const done = handle; handle = undefined; await done?.close(); throw error; }
      if (removed) await syncWindowDirectory(directory);
      return 'more';
    },
    async close() { const done = handle; handle = undefined; await done?.close(); },
  };
}
