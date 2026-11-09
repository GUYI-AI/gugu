import { snapshotWindowCommitReceipt, type WindowCommitReceipt, type WindowReceiptDatabase } from './window-commit-receipt';

export type PackPhysical = { dev: string; ino: string; size: string; mtimeNs: string; ctimeNs: string };
export type PackFrame = { groupId: string; name: string; sourceId: string; offset: number; length: number; sha256: string };
export type PackLocation = PackFrame & { physical: PackPhysical };
const id = (s: string) => typeof s === 'string' && /^[a-f0-9]{32}$/.test(s);
const name = (s: string) => typeof s === 'string' && /^[a-f0-9]{64}\.frame$/.test(s);
function frame(f: PackFrame) {
  if (!id(f.groupId) || !name(f.name) || typeof f.sourceId !== 'string' || f.sourceId.length > 256
    || !Number.isSafeInteger(f.offset) || f.offset < 0 || !Number.isSafeInteger(f.length) || f.length < 48 || f.length > 65584
    || !/^[a-f0-9]{64}$/.test(f.sha256)) throw new Error('Invalid pack frame position');
  return { groupId: f.groupId, name: f.name, sourceId: f.sourceId, offset: f.offset, length: f.length, sha256: f.sha256 };
}
function physical(p: PackPhysical) {
  if (!p || ![p.dev,p.ino,p.size,p.mtimeNs,p.ctimeNs].every(s => typeof s === 'string' && /^-?\d{1,40}$/.test(s))
    || BigInt(p.size) < 48n || BigInt(p.size) > 4194304n) throw new Error('Invalid pack physical identity');
  return { dev: p.dev, ino: p.ino, size: p.size, mtimeNs: p.mtimeNs, ctimeNs: p.ctimeNs };
}
/** The existing application gateway owns this connection. No new database is opened. */
export function createWindowPackIndex(db: WindowReceiptDatabase, receipt: (sourceId: string) => WindowCommitReceipt | null) {
  const atomic = <T>(run: () => T): T => {
    if (db.inTransaction) throw new Error('Pack publication cannot join an unfinished transaction');
    db.prepare('BEGIN IMMEDIATE').run();
    try { const result = run(); db.prepare('COMMIT').run(); return result; }
    catch (error) { db.prepare('ROLLBACK').run(); throw error; }
  };
  const assertReceipts = (sources: readonly WindowCommitReceipt[]) => {
    for (const value of sources) if (JSON.stringify(receipt(value.sourceId)) !== JSON.stringify(value))
      throw Object.assign(new Error('Pack lost its canonical receipt'), { code: 'needs_location' });
  };
  function lookup(groupId: string, key: string): PackLocation | null {
    const row = db.prepare(`SELECT f.group_id AS groupId,f.frame_name AS name,f.source_id AS sourceId,f.offset,f.length,f.sha256,g.physical
      FROM session_window_pack_frames f JOIN session_window_pack_groups g ON g.group_id=f.group_id
      WHERE f.group_id=? AND f.frame_name=? AND g.state='complete'`).get(groupId,key) as (PackFrame & { physical: string }) | undefined;
    if (!row) return null;
    if (typeof row.physical !== 'string' || Buffer.byteLength(row.physical) > 512) throw new Error('Invalid stored pack physical identity');
    const result = { ...frame(row), physical: physical(JSON.parse(row.physical)) };
    if (result.offset + result.length > Number(result.physical.size) || !receipt(result.sourceId)) return null;
    return result;
  }
  return {
    begin(groupId: string, input: readonly WindowCommitReceipt[]) {
      const sources = input.map(snapshotWindowCommitReceipt);
      if (!id(groupId) || sources.length < 1 || sources.length > 8 || new Set(sources.map(s => s.sourceId)).size !== sources.length
        || sources.some(s => s.sessionId !== sources[0].sessionId)) throw new Error('Invalid pack group');
      atomic(() => {
        assertReceipts(sources);
        db.prepare("INSERT INTO session_window_pack_groups(group_id,session_id,state) VALUES(?,?,'building')").run(groupId,sources[0].sessionId);
        for (const source of sources) db.prepare('INSERT INTO session_window_pack_sources(group_id,source_id) VALUES(?,?)').run(groupId,source.sourceId);
      });
      return sources;
    },
    current(key: string): PackLocation | null {
      if (!name(key)) throw new Error('Invalid frame key');
      const selected = db.prepare('SELECT group_id FROM session_window_pack_positions WHERE frame_name=?').get(key) as { group_id: string } | undefined;
      return selected ? lookup(selected.group_id,key) : null;
    },
    lookup,
    /** Direct dependencies of one committed group, never transitive. */
    dependencies(groupId: string, limit: number): PackLocation[] {
      if (!id(groupId)) throw new Error('Invalid pack group');
      const rows = db.prepare('SELECT dependency_id AS groupId,frame_name AS name FROM session_window_pack_dependencies WHERE group_id=? ORDER BY dependency_id LIMIT ?')
        .all(groupId,limit + 1) as { groupId: string; name: string }[];
      if (rows.length > limit) throw Object.assign(new Error('Pack dependency capacity exceeded'), { code: 'needs_location' });
      return rows.map(row => {
        const location = lookup(row.groupId,row.name);
        if (!location) throw Object.assign(new Error('Pack dependency is unavailable'), { code: 'needs_location' });
        return location;
      });
    },
    complete(groupId: string, p: PackPhysical, sources: readonly WindowCommitReceipt[], frames: readonly PackFrame[], dependencies: readonly PackLocation[]) {
      const saved = physical(p), members = new Set(sources.map(s => s.sourceId));
      if (!id(groupId) || frames.length < 1 || frames.length > 128 || dependencies.length > 128) throw new Error('Invalid pack commit size');
      atomic(() => {
        const group = db.prepare('SELECT state FROM session_window_pack_groups WHERE group_id=?').get(groupId) as { state: string } | undefined;
        if (group?.state !== 'building') throw new Error('Pack intent is unavailable');
        assertReceipts(sources);
        for (const d of dependencies) {
          const previous = lookup(d.groupId,d.name);
          if (!members.has(d.sourceId) || !previous || JSON.stringify(previous) !== JSON.stringify(d)) throw new Error('Pack checkpoint dependency changed');
          db.prepare('INSERT INTO session_window_pack_dependencies(group_id,dependency_id,frame_name,sha256) VALUES(?,?,?,?)')
            .run(groupId,d.groupId,d.name,d.sha256);
        }
        for (const input of frames) {
          const f = frame(input);
          if (f.groupId !== groupId || !members.has(f.sourceId) || f.offset + f.length > Number(saved.size)) throw new Error('Pack frame escaped group');
          db.prepare('INSERT INTO session_window_pack_frames(group_id,frame_name,source_id,offset,length,sha256) VALUES(?,?,?,?,?,?)')
            .run(groupId,f.name,f.sourceId,f.offset,f.length,f.sha256);
          db.prepare(`INSERT INTO session_window_pack_positions(frame_name,group_id) VALUES(?,?)
            ON CONFLICT(frame_name) DO UPDATE SET group_id=excluded.group_id`).run(f.name,groupId);
        }
        db.prepare("UPDATE session_window_pack_groups SET physical=?,state='complete' WHERE group_id=?").run(JSON.stringify(saved),groupId);
      });
    },
    recovery(after = '') {
      if (after !== '' && !id(after)) throw new Error('Invalid recovery cursor');
      const rows = db.prepare("SELECT group_id FROM session_window_pack_groups WHERE state IN ('building','abandoned') AND group_id>? ORDER BY group_id LIMIT 8")
        .all(after) as { group_id: string }[];
      return rows.map(row => {
        if (!id(row.group_id)) throw new Error('Invalid recovery intent');
        const sources = db.prepare('SELECT source_id FROM session_window_pack_sources WHERE group_id=? ORDER BY source_id LIMIT 9')
          .all(row.group_id) as { source_id: string }[];
        if (sources.length > 8) throw new Error('Pack intent source capacity exceeded');
        return { groupId: row.group_id, sources: sources.map(s => receipt(s.source_id)).filter((s): s is WindowCommitReceipt => s !== null) };
      });
    },
    forget(groupId: string) {
      if(!id(groupId))throw new Error('Invalid pack group');
      db.prepare(`DELETE FROM session_window_pack_groups WHERE group_id=? AND state='abandoned'
        AND NOT EXISTS(SELECT 1 FROM session_window_pack_frames f WHERE f.group_id=session_window_pack_groups.group_id)`).run(groupId);
    },
    abandon(groupId: string) {
      if (!id(groupId)) throw new Error('Invalid pack group');
      db.prepare("UPDATE session_window_pack_groups SET state='abandoned' WHERE group_id=? AND state='building'").run(groupId);
    },
  };
}
