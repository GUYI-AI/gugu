import type { TranscriptTurn } from '@gugu/session-core/acp';
import { createHash } from 'node:crypto';
import type { SessionRecordLocator, TurnStart } from '@gugu/session-core/session-record/contract';
import { isAgentActive, parseAgentStatus } from '@gugu/core/shared/agentStatus';
import { KV } from '@main/db/kv';
import { log } from '@main/lib/logger';
import { sessionRecordHarnessForProvider } from '@main/core/session-timeline/locate';
import { indexHermesPrompts, originalHermesPrompt } from '@gugu/session-core/acp/hermes-prompt';
import { readDeliveryEnvelope } from '@gugu/core/local/agent/deliveryEnvelope';
import { hashIdentity, identify, matchAfterStore, matchAfterStoreAt, recordIdentityFor, type Identity, type RecordIdentity } from './record-backfill-match';
import { readElidedPicture } from '@gugu/session-core/session-record/picture-elider';
import { appendRecordTurnNow, readUnfinishedRecordRowsNow, storedMessagesWithPromptHash, reviseRecordTurnNow, storedHeadNow, storedTurnsNewestFirstNow, withStoredTurns } from './session-turn-store';
import { sessionEngine, sessionProcess } from './session-process';

export type RecordBackfillResult = {
  inserted: number;
  status: 'complete' | 'active' | 'settling' | 'unavailable' | 'unsupported' | 'diverged' | 'cancelled' | 'runtime-changed';
};

/** What the last fill saw: the record's stamp and the store's newest row, so an unchanged session is not read at all. */
/**
 * What the last fill saw: the record's stamp and the store's newest row (an unchanged session is not read at all), the
 * cursor the next fill starts from, and the delivery ids in the record's user messages (null = some cannot be told).
 */
type Stamp = {
  record: string; storeHead: number; lastSettled: boolean; cursor?: Cursor; before?: SavedIdentity[]; deliveries?: string[] | null;
  /** The delivery ids of the turns before the cursor's: a read from the cursor adds what it reads to these. */
  deliveriesBefore?: string[] | null;
};

/** A record turn's (hashed) identity as the stamp keeps it, for the turns up to the cursor's (`Stamp.before`). */
type SavedIdentity = [keys: string[], fingerprint: string | null, prompt: string | null];
const toSaved = (one: Identity): SavedIdentity => [[...one.keys], one.fingerprint, one.prompt];
const fromSaved = ([keys, fingerprint, prompt]: SavedIdentity): Identity => ({ keys: new Set(keys), fingerprint, prompt });
const sameIdentity = (a: Identity, b: Identity) => a.fingerprint === b.fingerprint && a.prompt === b.prompt
  && a.keys.size === b.keys.size && [...a.keys].every(key => b.keys.has(key));
const stamps = new KV<Record<string, Stamp>>('record-stamp');

/** Store rows whose identities a fill reads up front: the widest window matched before resume-tail. */
const STORE_WINDOW = 200;

const digest = (text: string) => createHash('sha256').update(text).digest('base64url').slice(0, 16);

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
 * resume-tail: the fill reads only the gap. An unchanged record (its stamp) is not read at all. Otherwise it is decoded
 * from the cursor the last fill left (where a settled turn starts, the decoder state and turn index there, and that
 * turn's stored row), or from its beginning when there is none or the record no longer shows it. The stamp also keeps
 * the identities of the turns before the cursor: matching runs on the whole record's sequence either way, so a fill
 * from the cursor plans what a fill from the beginning plans (EQUIVALENCE.md). One pass finds the plan from turn
 * identities alone, a second writes the turns after the anchor as they stream. Settled turns never accumulate: memory
 * is the open turns, one turn and an identity per turn, whatever the record's size.
 */
export async function syncStoredHistoryFromRecord(sessionId: string, options: { signal?: AbortSignal; runtime?: 'pty' } = {}): Promise<RecordBackfillResult> {
  const { readSessionRow, locateRow } = await import('@main/core/session-timeline/service');
  const { createSessionRecordSource } = await import('@gugu/session-core/session-record');
  const { readRecordFrom } = await import('@gugu/session-core/session-record/fill-read');
  return withStoredTurns(sessionId, async () => {
    const result = (status: RecordBackfillResult['status'], inserted = 0): RecordBackfillResult => ({ inserted, status });
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
    // A terminal reports idle before its buffered record write lands. While its engine runs (owned, or in tmux and
    // not yet reattached after a restart), an unsettled last turn is still being written; once it is gone, the record is final.
    const finish = async (inserted: number, complete: boolean, lastSettled: boolean) => {
      if (inserted > 0) log.info('[record-backfill] filled in turns from the record', { sessionId, inserted });
      if (!current()) return result('runtime-changed', inserted);
      if (!complete || active()) return result('active', inserted);
      return result(row.runtime !== 'acp' && !lastSettled && await sessionEngine(sessionId) !== 'gone' ? 'settling' : 'complete', inserted);
    };

    const location = locateRow(row);
    if (!location.supported) return result('unavailable');
    const parentId = row.config?.forkedFrom?.sessionId;
    const parentRow = parentId ? readSessionRow(parentId, { includeArchived: true }) : null;
    const parentLocation = parentRow ? locateRow(parentRow) : null;
    if (parentId && !parentLocation?.supported) return result('diverged');

    // Unchanged record and store: nothing can be missing.
    const probe = createSessionRecordSource(location.locator);
    // A record the live mode cannot stamp (a `.zst` archive) is stamped as the snapshot read sees it; no stamp = read it.
    const stampOf = (source: typeof probe) => source.stamp ? source.stamp().catch(() => null) : Promise.resolve(null);
    const stamp = await stampOf(probe) ?? await stampOf(createSessionRecordSource(location.locator, { readMode: 'snapshot' }));
    const head = storedHeadNow(sessionId);
    const saved = await stamps.get(sessionId);
    if (stamp && saved && saved.record === stamp && saved.storeHead === head && !committedOnly) return finish(0, true, saved.lastSettled);

    // Identities of the store's newest rows, one row at a time (a row can hold megabytes of pictures); Hermes prompts are
    // matched by the receipts in those rows' messages.
    const storeIdentities = (limit: number) => {
      const rows: Array<{ seq: number; identity: Identity }> = [];
      const messages: TranscriptTurn['items'] = [];
      for (const one of storedTurnsNewestFirstNow(sessionId, limit)) {
        rows.push({ seq: one.seq, identity: hashIdentity(identify(one.turn), digest) });
        if (harness === 'hermes') messages.push(...one.turn.items.filter(item => item.kind === 'message'));
      }
      return { rows, messages };
    };
    const window = storeIdentities(STORE_WINDOW);
    const hermes = harness === 'hermes' ? indexHermesPrompts(window.messages) : undefined;
    const unfinished = readUnfinishedRecordRowsNow(sessionId).map(one => ({ seq: one.seq, identity: hashIdentity(identify(one.turn), digest) }));
    let parentLineage: Awaited<ReturnType<typeof readRecordFrom>>['lineage'] | undefined;

    try {
      if (parentRow && parentLocation?.supported) {
        // A fork proves its parent's prefix once, by a snapshot read of the parent; nothing of it is kept.
        const parent = await readRecordFrom({ locator: parentLocation.locator, sessionId: parentRow.id, position: 0, snapshot: true, fill: true, onSettled: () => {} });
        parentLineage = parent.lineage ?? undefined;
        if (!parentLineage?.length) return result('diverged');
      }

      // First pass: turn identities only, and the delivery ids of every turn read; from the cursor, else the beginning.
      const scan = async (position: number, at?: { state?: unknown; turn: number }) => {
        const seen: Identity[] = [];
        // Per turn read, in order: its delivery ids, null = cannot be told.
        const deliveries: Array<string[] | null> = [];
        let unreceipted = false;
        const take = (turn: TranscriptTurn) => {
          if (hermes && turn.items.some(item => item.kind === 'message' && item.role === 'user' && originalHermesPrompt(item.text, hermes) === null)) unreceipted = true;
          seen.push(hashIdentity(identify(turn, hermes), digest));
        };
        const note = (turn: TranscriptTurn) => {
          const ids = new Set<string>();
          deliveries.push(noteDeliveries(turn, ids, sessionId, harness ?? '') ? [...ids] : null);
        };
        const read = await readRecordFrom({ locator: location.locator, sessionId, position, ...(at ? { at } : {}), ...(parentLineage ? { parentLineage } : {}),
          fill: true, onSettled: turns => turns.forEach(turn => { take(turn); note(turn); }) });
        const prefix = committedOnly && read.tail.length > read.committed ? read.tail.slice(0, read.committed) : read.tail;
        prefix.forEach(take);
        read.tail.forEach(note);
        return { seen, unreceipted, deliveries, from: read.from, complete: prefix.length === read.tail.length, lastSettled: !!prefix.at(-1)?.outcome };
      };
      // A cursor read sees the turns from the cursor's on; the stamp keeps the identities and delivery ids of the record
      // before them, so matching (and the delivery set) see the whole record as a read from the beginning does.
      // The record must still hold, up to the cursor, what it held when the cursor was saved (`checkAt`): not rewound,
      // rewritten or replaced there.
      const kept = saved?.cursor?.check && saved.before?.length === saved.cursor.turn + 1 && saved.deliveriesBefore !== undefined
        && await probe.checkAt?.(saved.cursor.position).catch(() => null) === saved.cursor.check ? saved : null;
      const cursor = !parentLineage && kept ? kept.cursor! : null;
      let scanned = cursor ? await scan(cursor.position, cursor) : null;
      if (options.signal?.aborted) return result('cancelled');
      // The cursor's turn must still be there as it was; else (rewound, rewritten, replaced) read from the beginning.
      const resumed = !!cursor && !!scanned && scanned.from === cursor.position && scanned.seen.length > 0
        && sameIdentity(scanned.seen[0], fromSaved(kept!.before!.at(-1)!));
      if (!resumed) {
        scanned = await scan(0);
        if (options.signal?.aborted) return result('cancelled');
      }
      const base = resumed ? cursor!.turn : 0;
      const seen = [...(resumed ? kept!.before!.slice(0, -1).map(fromSaved) : []), ...scanned!.seen];
      // The record's delivery ids: those before the cursor (saved) and those of every turn read from it.
      const prior = resumed ? kept!.deliveriesBefore! : [];
      const idsOf = (turns: Array<string[] | null>) => prior === null || turns.includes(null) ? null : [...new Set([...prior, ...turns.flat() as string[]])];
      const deliveries = idsOf(scanned!.deliveries);
      const diverged = async () => {
        await stamps.setOrThrow(sessionId, { record: '', storeHead: head, lastSettled: true, deliveries });
        return result('diverged');
      };
      // A record turn whose Hermes prompt the store cannot vouch for: the two diverged (as before).
      if (scanned!.unreceipted) return diverged();
      let found = matchPlan(seen, window.rows, unfinished, identity, window.rows.length < STORE_WINDOW);
      // The store's newest rows are still ambiguous: compare against every stored row (as before).
      if (found === null && window.rows.length >= STORE_WINDOW) found = matchPlan(seen, storeIdentities(Number.MAX_SAFE_INTEGER).rows, unfinished, identity, true);
      if (found === null) log.warn('[record-backfill] the record and the store diverged; nothing filled in', { sessionId });
      if (found === null || found === 'diverged') return diverged();
      const plan: Plan = { ...found, from: scanned!.from, complete: scanned!.complete, lastSettled: scanned!.lastSettled };

      // Second pass: the same start; turns after the anchor are written as they stream, their long pictures as their place
      // in the record (read back when opened). The newest settled turn whose stored row is known becomes the next cursor.
      // The plan may write a turn before the cursor's (an unfinished row that an earlier turn of the same identity now
      // completes): the second pass then reads from the beginning, so every planned turn is read.
      const early = resumed && Array.from({ length: base }, (_, at) => at).some(at => plan.revise.has(at) || plan.append(at));
      const second = early ? { from: 0, base: 0 } : { from: plan.from, base };
      let inserted = 0, index = second.base;
      let next: Cursor | null = null;
      const write = (turn: TranscriptTurn, start: TurnStart | null) => {
        const at = index++;
        // An open turn changes identity as it completes: it could not be recognized at the cursor.
        const known = (seq: number) => { if (start && turn.outcome && at < seen.length) next = { ...start, turn: at, seq }; };
        const seq = plan!.revise.get(at);
        if (seq === undefined && !plan!.append(at)) {
          if (plan!.anchor?.seen === at) known(plan!.anchor.seq);
          return;
        }
        if (options.signal?.aborted) throw new FillStopped('cancelled');
        if (!current()) throw new FillStopped('runtime-changed');
        // If a new turn started during an idle snapshot, leave its unproved suffix for the settled edge.
        if (row.runtime !== 'acp' && !committedOnly && active()) throw new FillStopped('active');
        const kept = elidedAsRefs(turn);
        if (seq !== undefined) { reviseRecordTurnNow(sessionId, seq, kept); known(seq); }
        else { known(appendRecordTurnNow(sessionId, kept)); inserted++; }
      };
      try {
        const read = await readRecordFrom({ locator: location.locator, sessionId, position: second.from, ...(resumed && !early ? { at: cursor! } : {}),
          ...(parentLineage ? { parentLineage } : {}), fill: true, onSettled: (turns, _from, starts) => turns.forEach((turn, at) => write(turn, starts[at])) });
        if (read.from !== second.from) throw new Error('record-backfill: the second pass started elsewhere than planned');
        const held = committedOnly && read.tail.length > read.committed ? read.committed : read.tail.length;
        for (let at = 0; at < held; at += 1) write(read.tail[at], read.tailStarts[at]);
      } catch (error) {
        if (error instanceof FillStopped) return result(error.status, inserted);
        throw error;
      }
      if (inserted < plan.appended) log.warn('[record-backfill] fewer turns than planned', { sessionId, planned: plan.appended, inserted });
      const done = await finish(inserted, plan.complete, plan.lastSettled);
      // The cursor holds whatever the status; the stamp lets the next fill skip the record only once this one completed.
      const placed = next as Cursor | null;
      const check = placed ? await probe.checkAt?.(placed.position).catch(() => null) ?? null : null;
      const after: Cursor | null = placed && check ? { ...placed, check } : resumed ? cursor : null;
      await stamps.setOrThrow(sessionId, { record: done.status === 'complete' && stamp ? stamp : '', storeHead: storedHeadNow(sessionId),
        lastSettled: plan.lastSettled, deliveries, ...(after ? { cursor: after, before: seen.slice(0, after.turn + 1).map(toSaved),
          deliveriesBefore: idsOf(scanned!.deliveries.slice(0, after.turn - base)) } : {}) });
      return done;
    } catch (error) {
      log.warn('[record-backfill] record unreadable', { sessionId, error: (error as Error)?.message ?? String(error) });
      if ((error as Error)?.name === 'SessionRecordNotFoundError') return result('unavailable');
      if ((error as Error)?.name === 'SessionRecordForkDivergedError') {
        // The record no longer extends its parent: its deliveries are still the ones in its user messages (as before).
        const deliveries = await recordDeliveryIdsOf(location.locator, sessionId, harness ?? '').catch(() => null);
        await stamps.setOrThrow(sessionId, { record: '', storeHead: head, lastSettled: true, deliveries });
        return result('diverged');
      }
      return result('unavailable');
    } finally {
      probe.stop();
    }
  });
}

/** A filled-in picture, from the session's record as it is now (`readFilledPicture` in session-core); null = not there. */
export async function readFilledPicture(sessionId: string, place: { start: number; chars: number; head: string; tail: string }): Promise<string | null> {
  const { readSessionRow, locateRow } = await import('@main/core/session-timeline/service');
  const row = readSessionRow(sessionId, { includeArchived: true });
  const location = row ? locateRow(row) : null;
  if (!location?.supported) return null;
  const { readFilledPicture: fromRecord } = await import('@gugu/session-core/session-record/fill-read');
  return fromRecord(location.locator, place);
}

/**
 * #980 Which deliveries the session's record shows the agent received: the delivery ids in its user messages, as the
 * last fill saw them (`Stamp.deliveries`). null = the record was never read here, or some prompt cannot be told.
 */
export async function recordedDeliveryIds(sessionId: string): Promise<string[] | null> {
  return (await stamps.get(sessionId))?.deliveries ?? null;
}

/** Every delivery id in a record's user messages, by one streaming read from its beginning; null = some cannot be told. */
async function recordDeliveryIdsOf(locator: SessionRecordLocator, sessionId: string, harness: string): Promise<string[] | null> {
  const { readRecordFrom } = await import('@gugu/session-core/session-record/fill-read');
  const ids = new Set<string>();
  let unknown = false;
  const note = (turn: TranscriptTurn) => { if (!noteDeliveries(turn, ids, sessionId, harness)) unknown = true; };
  const read = await readRecordFrom({ locator, sessionId, position: 0, snapshot: true, fill: true, onSettled: turns => turns.forEach(note) });
  read.tail.forEach(note);
  return unknown ? null : [...ids];
}

/** Add a turn's delivery ids to `into`; false = some prompt of it cannot be told. */
function noteDeliveries(turn: TranscriptTurn, into: Set<string>, sessionId: string, harness: string): boolean {
  let known = true;
  for (const item of turn.items) {
    if (item.kind !== 'message' || item.role !== 'user') continue;
    const found = turnDeliveryIds(item.text, harness === 'hermes' ? (text) => hermesOriginal(sessionId, text) : null);
    if (found === null) known = false;
    else for (const id of found) into.add(id);
  }
  return known;
}

/** The delivery ids of one recorded user prompt; null = cannot be told (a Hermes prompt without its host original). */
function turnDeliveryIds(text: string, original: ((text: string) => string | null | undefined) | null): string[] | null {
  const host = original ? original(text) : undefined;
  if (host === null) return null;
  const reading = readDeliveryEnvelope(host ?? text);
  // An old merged Hermes row without a host boundary is unknown, never evidence of an empty inbox (as before).
  if (original && !reading && host === undefined && /<gugu_deliver(?:y|ies)[\s>]/.test(text)) return null;
  return reading?.segments.flatMap(segment => segment.facts?.messageId ? [segment.facts.messageId] : []) ?? [];
}

/** A Hermes prompt's host original, by the receipt a stored row of this session carries for it (`hermes-prompt.ts`). */
function hermesOriginal(sessionId: string, text: string): string | null | undefined {
  return originalHermesPrompt(text, indexHermesPrompts(storedMessagesWithPromptHash(sessionId, text)));
}

class FillStopped extends Error {
  constructor(readonly status: RecordBackfillResult['status']) { super(status); }
}

type Plan = {
  from: number;
  /** Record turn (index from `from`) → the unfinished store row it completes. */
  revise: Map<number, number>;
  /** Whether a record turn is appended: the matched ones, and any the record grew by between the passes. */
  append: (index: number) => boolean;
  appended: number;
  /** The newest record turn recognized as a stored row, and that row's seq. */
  anchor: { seen: number; seq: number } | null;
  complete: boolean;
  lastSettled: boolean;
};

/**
 * Where the next fill starts: a turn's place in the record, the decoder state and turn index a read from the beginning
 * has there (so a read from it decodes and numbers as that read), and the stored row of that turn.
 */
type Cursor = { position: number; state?: unknown; timeline?: unknown; turn: number; seq: number; check?: string };

/**
 * The store's rows (newest first) matched against the whole record's turn identities (`matchAfterStore`, the windows of
 * before); `null` = they do not anchor. Indexes are the record's turn indexes.
 */
function matchPlan(
  seen: Identity[],
  stored: Array<{ seq: number; identity: Identity }>,
  unfinished: Array<{ seq: number; identity: Identity }>,
  identity: RecordIdentity,
  storeComplete: boolean,
): Omit<Plan, 'from' | 'complete' | 'lastSettled'> | 'diverged' | null {
  const revise = new Map<number, number>();
  for (let at = 0; at < seen.length; at += 1) {
    const hits = unfinished.filter(one => matchAfterStore([seen[at]], [one.identity], identity)?.length === 0);
    if (hits.length > 1) return 'diverged';
    if (hits.length === 1) revise.set(at, hits[0].seq);
  }
  let matched: ReturnType<typeof matchAfterStoreAt> = null;
  let rows = stored;
  if (seen.length === 0) matched = { missing: [], anchor: null };
  else {
    const windows = identity === 'content' ? [10, 50, 200, Number.MAX_SAFE_INTEGER] : [10, 50, 200];
    for (const limit of windows) {
      rows = stored.slice(0, limit);
      matched = matchAfterStoreAt(seen, rows.map(row => row.identity), identity,
        { hasOlderStoredTurns: rows.length === limit || (!storeComplete && rows.length === stored.length) });
      if (matched !== null || rows.length < limit) break;
    }
  }
  if (matched === null) return null;
  const append = new Set(matched.missing.filter(at => !revise.has(at)));
  return {
    revise, appended: append.size,
    anchor: matched.anchor ? { seen: matched.anchor.seen, seq: rows[matched.anchor.stored].seq } : null,
    append: (index) => append.has(index) || index >= seen.length,
  };
}

/**
 * A long picture the fill left in the record is stored as its size and its place there (`imageRefs`), not its bytes:
 * the turn came from that record, and the picture is read back from it when opened (`getStoredToolImage`). A tool node
 * keeps either `images` or `imageRefs`; next to an elided one, a short picture keeps its size only.
 */
function elidedAsRefs(turn: TranscriptTurn): TranscriptTurn {
  const visit = (items: TranscriptTurn['items']): TranscriptTurn['items'] => {
    let changed = false;
    const next = items.map((item) => {
      const node = item as unknown as { images?: Array<{ mimeType: string; data: string }>; children?: TranscriptTurn['items'] };
      let out = item;
      if (node.images?.some(image => readElidedPicture(image.data))) {
        const { images, ...rest } = node;
        out = { ...rest, imageRefs: images.map(({ mimeType, data }) => {
          const place = readElidedPicture(data);
          return place ? { mimeType, chars: place.chars, record: { start: place.start, head: place.head, tail: place.tail } } : { mimeType, chars: data.length };
        }) } as unknown as typeof item;
      }
      const children = (out as typeof node).children;
      const kept = children ? visit(children) : children;
      if (kept !== children) out = { ...out, children: kept } as typeof item;
      if (out !== item) changed = true;
      return out;
    });
    return changed ? next : items;
  };
  const items = visit(turn.items);
  return items === turn.items ? turn : { ...turn, items };
}
