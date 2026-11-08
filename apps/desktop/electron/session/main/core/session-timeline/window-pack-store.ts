import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import { link, open, rm, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { registerWindowFrameBackend, type WindowFrameBackend } from '@gugu/session-core/session-record/window-cache/frame-backend';
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
type Build = { sources: WindowCommitReceipt[]; group?: Group; carry?: PackLocation; closed: boolean };
export type WindowPackObserver = (phase: 'intent' | 'pack_synced' | 'directory_synced' | 'positions_committed', groupId: string) => void;

/** One application gateway and a task-local private view. External readers only
 * see offsets published by the SQLite group transaction. Pack bodies never enter
 * a Map; it holds at most 128 scalar positions and one encoded frame at a time. */
export function createWindowPackStore(directory: string, db: WindowReceiptDatabase, observed?: WindowPackObserver) {
  const receipts = createWindowCommitReceipts(db), index = createWindowPackIndex(db, receipts.bySource);
  const local = new AsyncLocalStorage<Build>(), active = new Set<Build>(); let closed = false;
  const path = (id: string) => join(directory, `${id}.pack`);
  function selected() {
    const build = local.getStore();
    if (closed || !build || build.closed || !active.has(build)) throw new Error('Frame write has no active pack group');
    return build;
  }
  async function start(build: Build) {
    const id = randomUUID().replaceAll('-', ''); index.begin(id,build.sources);
    const group: Group = { id, bytes: 0, writes: 0, frames: new Map(), dependencies: new Map(build.carry ? [[`${build.carry.groupId}/${build.carry.name}`,build.carry]] : []) }; build.group = group;
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
    // A progress pack may end between a data page and its next checkpoint.
    // Carry the previous atomic group's physical proof into the next group even
    // when that checkpoint is written before the page is read again.
    const last=[...group.frames.values()].at(-1)!;
    build.carry=index.lookup(group.id,last.name)??undefined;
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
        const dependencies = build.group!.dependencies, dependencyKey = `${location.groupId}/${name}`;
        if (!dependencies.has(dependencyKey) && dependencies.size >= 128) { await flush(build); await start(build); }
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
  return {
    proof(name: string) {
      const location=index.current(name);if(!location)throw fault('Packed publication has no committed location');
      return ()=>{
        const current=index.lookup(location.groupId,name);
        if(!current||JSON.stringify(current)!==JSON.stringify(location))throw fault('Packed publication lost its canonical position');
        try{const physical=statSync(path(location.groupId),{bigint:true});
          if(!physical.isFile()||!same(identity(physical),location.physical))throw fault('Packed publication physical identity changed');
        }catch{throw fault('Packed publication physical identity changed');}
      };
    },
    backend, // Keep the weak namespace registration alive for this owner.
    /** Invocations are independent. The dispatcher chooses at most eight same-
     * conversation receipts; a giant build emits bounded progress packs. */
    async build<T>(sources: readonly WindowCommitReceipt[], run: () => Promise<T>): Promise<T> {
      if (closed || active.size >= 32) throw new Error('Pack store is closed or occupied');
      const saved = sources.map(snapshotWindowCommitReceipt);
      if (saved.length < 1 || saved.length > 8 || saved.some(s => s.sessionId !== saved[0].sessionId)
        || [...active].some(b => b.sources.some(s => saved.some(v => v.sourceId === s.sourceId)))) throw new Error('Pack sources are occupied or invalid');
      const build: Build = { sources: saved, closed: false }; active.add(build);
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
