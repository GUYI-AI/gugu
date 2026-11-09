import type { TranscriptTurn } from '@gugu/session-core/acp';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { isAgentActive, parseAgentStatus } from '@gugu/core/shared/agentStatus';
import { KV } from '@main/db/kv';
import { log } from '@main/lib/logger';
import { sessionRecordHarnessForProvider } from '@main/core/session-timeline/locate';
import { hashIdentity, identify, recordIdentityFor, recordTurnsAfterStore, type RecordIdentity } from './record-backfill-match';
import { digest, STORE_TAIL, toWire, type IngestRequest } from './record-ingest/plan';
import type { IngestRunner, IngestSession } from './record-ingest/runner';
import { appendRecordTurnNow, readStoredTailNow, readUnfinishedRecordRowsNow, readUnfinishedRecordTurnsNow, reviseRecordTurnNow, storedMaxSeqNow, storedTurnsNewestFirstNow, withStoredTurns } from './session-turn-store';
import { sessionEngine, sessionProcess } from './session-process';

export type RecordBackfillResult = {
  inserted: number;
  status: 'complete' | 'active' | 'settling' | 'unavailable' | 'unsupported' | 'diverged' | 'ingest_failed' | 'cancelled' | 'runtime-changed';
  /**
   * Delivery ids in every turn of the record, when this fill read it to its end (resume-mem): the agent received these.
   * Absent = not known from this fill.
   */
  deliveryIds?: string[];
};

/** Where the ingest child keeps one checkpoint per session and generation, and its spill files. */
let ingestDir: (() => string) | null = null;
let ingestRunner: IngestRunner | null = null;
/** Tests run the child's own code in process; production spawns the child (`record-ingest/runner.ts`). */
export function setRecordIngest(next: { dir: () => string; runner: IngestRunner } | null): void {
  ingestDir = next?.dir ?? null;
  ingestRunner = next?.runner ?? null;
}

type Cursor = { generation: number; storeSeq: number };
const cursors = new KV<Record<string, Cursor>>('record-ingest');

/**
 * #980 把 agent 自己的记录里有、库里(`session_turns`)还没有的那几轮补进库。
 *
 * 会话页的历史以 agent 自己的记录为准,库只是缓存:编程模式(终端)里跑的轮、在咕咕外面直接用命令跑的轮、
 * #5381 之前建的会话(库是空的),都只在记录里。从前它们靠「重放 + 按条数对齐」补进来 —— 条数在压缩、失败的轮
 * 之后就对不齐;而接回会话已经不再重放。
 *
 * 新轮只接在库尾;同一条记录轮的迟到答复在原行更新,不改它的库内顺序/引用。
 * 本次改动之前就漏在中间的那些轮(老会话里早年在终端跑过的)不补 —— 接在末尾会把次序打乱,比缺着更糟。
 *
 * resume-mem: Claude and Codex records are read by the ingest child, which keeps a checkpoint so the next fill reads only
 * what the record grew by; this process writes one batch at a time and never decodes the record (DESIGN v3).
 */
export async function syncStoredHistoryFromRecord(sessionId: string, options: { signal?: AbortSignal; runtime?: 'pty' } = {}): Promise<RecordBackfillResult> {
  const { readSessionRow, pickRecordTurns, locateRow } = await import('@main/core/session-timeline/service');
  return withStoredTurns(sessionId, async () => {
    const result = (status: RecordBackfillResult['status'], inserted = 0, deliveryIds?: string[]): RecordBackfillResult =>
      ({ inserted, status, ...(deliveryIds ? { deliveryIds } : {}) });
    if (options.signal?.aborted) return result('cancelled');
    // Runtime and record identity are read inside the same queue as live writes, never from a pre-queue snapshot.
    const row = readSessionRow(sessionId, { includeArchived: true });
    if (!row) return result('unavailable');
    if (options.runtime === 'pty' && row.runtime === 'acp') return result('runtime-changed');
    const harness = sessionRecordHarnessForProvider(row.provider);
    const identity = recordIdentityFor(harness);
    if (!identity) return result('unsupported');
    if (!row.providerSessionId) return result('unavailable');
    if (row.runtime === 'acp') {
      const { acpSessionLive } = await import('@main/core/session-timeline/write-bridge');
      if (await acpSessionLive(sessionId)) return result('active');
    }
    const current = () => {
      const latest = readSessionRow(sessionId, { includeArchived: true });
      return latest && latest.runtime === row.runtime && latest.provider === row.provider
        && latest.providerSessionId === row.providerSessionId;
    };
    const active = () => {
      const latest = readSessionRow(sessionId, { includeArchived: true });
      if (!latest || latest.archivedAt) return false;
      const status = parseAgentStatus(latest.agentStatus);
      return isAgentActive(status ? { status } : null) || (!status && sessionProcess(sessionId) !== null);
    };
    // End metadata is not a liveness signal: a stopped/crashed terminal can retain an unfinished last turn.
    const committedOnly = row.runtime !== 'acp' && active();
    const parentId = row.config?.forkedFrom?.sessionId;

    let inserted = 0;
    let processed = 0;
    // Returns a status to stop with, or null to go on.
    const write = async (turn: TranscriptTurn, seq: number | undefined): Promise<RecordBackfillResult['status'] | null> => {
      if (options.signal?.aborted) return 'cancelled';
      if (!current()) return 'runtime-changed';
      // If a new turn started during an idle snapshot, leave its unproved suffix for the settled edge.
      if (row.runtime !== 'acp' && !committedOnly && active()) return 'active';
      if (seq !== undefined) await reviseRecordTurnNow(sessionId, seq, turn);
      else { await appendRecordTurnNow(sessionId, turn); inserted++; }
      // Reuse the account feed's serial worker; yield without starting another queue or polling loop.
      if (options.signal && ++processed % 64 === 0) await pause(200, undefined, { signal: options.signal });
      return null;
    };
    const finish = async (complete: boolean, lastSettled: boolean, deliveryIds?: string[]) => {
      if (inserted > 0) log.info('[record-backfill] filled in turns from the record', { sessionId, inserted });
      if (!current()) return result('runtime-changed', inserted, deliveryIds);
      if (!complete || active()) return result('active', inserted, deliveryIds);
      // A terminal reports idle before its buffered record write lands. While its engine runs (owned, or in tmux and
      // not yet reattached after a restart), an unsettled last turn is still being written; once it is gone, the record is final.
      return result(row.runtime !== 'acp' && !lastSettled && await sessionEngine(sessionId) !== 'gone' ? 'settling' : 'complete', inserted, deliveryIds);
    };

    if (harness === 'hermes') {
      // Hermes reads its sqlite store, not a JSONL record: it keeps the in-process pick (resume-mem DESIGN v3 C5).
      const unfinished = await readUnfinishedRecordTurnsNow(sessionId);
      const revisions = new Map<string, number>();
      let lastSettled = true;
      const picked = await pickRecordTurns(sessionId, async (record) => {
        if (record.length === 0) return [];
        lastSettled = !!record.at(-1)!.outcome;
        let missing: TranscriptTurn[] | null = null;
        for (const limit of [...HERMES_TAIL_WINDOWS, Number.MAX_SAFE_INTEGER]) {
          const tail = await readStoredTailNow(sessionId, limit);
          missing = recordTurnsAfterStore(record, tail, identity, { hasOlderStoredTurns: tail.length === limit, hermesPromptReceipts: true });
          if (missing !== null || tail.length < limit) break;
        }
        if (missing === null) return null;
        const revised: TranscriptTurn[] = [];
        for (const turn of record) {
          const matches = unfinished.filter(stored => recordTurnsAfterStore([turn], [stored], identity)?.length === 0);
          if (matches.length > 1) return null;
          if (matches.length === 0) continue;
          revisions.set(turn.id, matches[0].seq);
          revised.push(turn);
        }
        return [...revised, ...missing];
      }, { images: true, committedOnly, includeArchived: true, afterForkOf: parentId });
      if (!picked.ok) return result(picked.reason === 'too_large' ? 'ingest_failed' : picked.reason ?? 'unavailable');
      if (picked.turns === null) {
        log.warn('[record-backfill] the record and the store diverged; nothing filled in', { sessionId });
        return result('diverged');
      }
      for (const turn of picked.turns) {
        const stop = await write(turn, revisions.get(turn.id));
        if (stop) return result(stop, inserted);
      }
      return finish(picked.complete, lastSettled);
    }

    const location = locateRow(row);
    if (!location.supported) return result('unavailable');
    const parentRow = parentId ? readSessionRow(parentId, { includeArchived: true }) : null;
    const parentLocation = parentRow ? locateRow(parentRow) : null;
    if (parentId && !parentLocation?.supported) return result('diverged');
    const dir = ingestDir ? ingestDir() : join((await import('electron')).app.getPath('userData'), 'record-ingest');
    const runner = ingestRunner ?? (await import('./record-ingest/runner')).childProcessIngest;
    const cursor = await cursors.get(sessionId);
    const generation = (cursor?.generation ?? 0) + 1;
    const checkpointOf = (one: number) => join(dir, `${sessionId}.${one}.ckpt`);
    const wire = (turn: TranscriptTurn) => toWire(hashIdentity(identify(turn), digest));
    const storeRows = async (fromSeq?: number, limit?: number) => {
      const rows: IngestRequest['stored'] = [];
      for await (const one of storedTurnsNewestFirstNow(sessionId, { fromSeq, limit })) rows.push({ seq: one.seq, identity: wire(one.turn) });
      return rows;
    };
    const unfinished = (await readUnfinishedRecordRowsNow(sessionId)).map((one) => ({ seq: one.seq, identity: wire(one.turn) }));
    const request = async (mode: 'cursor' | 'tail' | 'store'): Promise<IngestRequest> => {
      const stored = mode === 'cursor' ? await storeRows(cursor!.storeSeq) : await storeRows(undefined, mode === 'tail' ? STORE_TAIL : undefined);
      return {
        sessionId,
        locator: location.locator,
        ...(parentRow && parentLocation?.supported ? { parent: { sessionId: parentRow.id, locator: parentLocation.locator } } : {}),
        identity: identity as RecordIdentity,
        committedOnly,
        checkpoint: mode === 'cursor' ? checkpointOf(cursor!.generation) : null,
        checkpointOut: checkpointOf(generation),
        spill: join(dir, `${sessionId}.spill`),
        stored,
        storeComplete: mode !== 'tail' || stored.length < STORE_TAIL,
        unfinished,
      };
    };

    let session: IngestSession | null = null;
    const startedAt = Date.now();
    try {
      const { mkdir } = await import('node:fs/promises');
      await mkdir(dir, { recursive: true });
      for (const mode of cursor ? ['cursor', 'tail', 'store'] as const : ['tail', 'store'] as const) {
        if (options.signal?.aborted) return result('cancelled');
        session = await runner(await request(mode));
        const status = session.summary.status;
        if (status !== 'retry_full' && status !== 'need_store') break;
        await session.dispose();
        session = null;
        if (status === 'retry_full' && mode !== 'cursor') throw new Error('record-ingest: retry_full without a checkpoint');
      }
      const { summary } = session!;
      log.info('[record-backfill] record ingest', { sessionId, status: summary.status, resumed: summary.resumed,
        revise: summary.revise, append: summary.append, ms: Date.now() - startedAt });
      if (summary.status === 'retry_full' || summary.status === 'need_store') throw new Error(`record-ingest: ${summary.status} after every mode`);
      if (summary.prunedDrops > 0) log.info('[record-backfill] dropped late events for settled turns', { sessionId, events: summary.prunedDrops });
      if (summary.status === 'unavailable') return result('unavailable');
      if (summary.status === 'diverged') {
        log.warn('[record-backfill] the record and the store diverged; nothing filled in', { sessionId });
        return result('diverged', 0, summary.deliveryIds);
      }
      for (let batch = await session!.next(); batch; batch = await session!.next()) {
        for (const one of batch.revise) {
          const stop = await write(one.turn, one.seq);
          if (stop) return result(stop, inserted);
        }
        for (const turn of batch.append) {
          const stop = await write(turn, undefined);
          if (stop) return result(stop, inserted);
        }
      }
      if (summary.checkpointWritten) {
        // The cursor moves only after every batch is in: a crash before this line re-reads from the old checkpoint, and
        // the turns already written are then newer than its store window and are recognized, not appended twice.
        const appended = inserted > 0 ? await storedMaxSeqNow(sessionId) : -1;
        const storeSeq = Math.max(appended, summary.recognizedSeq ?? -1, cursor?.storeSeq ?? -1);
        await cursors.setOrThrow(sessionId, { generation, storeSeq });
        if (cursor) await rm(checkpointOf(cursor.generation), { force: true });
      }
      return finish(summary.complete, summary.lastSettled, summary.deliveryIds);
    } catch (error) {
      log.warn('[record-backfill] record ingest failed', { sessionId, error: (error as Error)?.message ?? String(error) });
      return result('ingest_failed', inserted);
    } finally {
      await session?.dispose();
      await rm(join(dir, `${sessionId}.spill`), { force: true }).catch(() => {});
    }
  });
}

const HERMES_TAIL_WINDOWS = [10, 50, 200] as const;
