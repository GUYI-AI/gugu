import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import type { TranscriptTurn } from '@gugu/session-core/acp';
import type { RecordLineageNode, SessionRecordLocator, TimelineArchive } from '@gugu/session-core/session-record';
import { SessionRecordNotFoundError, trimTurnsForTransport } from '@gugu/session-core/session-record';
import { readRecordForIngest, type IngestRead } from '@gugu/session-core/session-record/ingest';
import { readDeliveryEnvelope } from '@gugu/core/local/agent/deliveryEnvelope';
import { hashIdentity, identify, matchAfterStore, type Identity, type RecordIdentity } from '../record-backfill-match';

/**
 * What the ingest child does for one session (resume-mem DESIGN v3 §3): read the record without holding it, keep one
 * hashed identity per record turn, spill the turns that may be copied, match them against the store with the same
 * function the host used before (`matchAfterStore`), then hand out batches the host writes.
 *
 * Runs only in the ingest child process (`entry.ts`); the host never decodes the record.
 */
export type WireIdentity = { keys: string[]; fingerprint: string | null; prompt: string | null };

export type IngestRequest = {
  sessionId: string;
  locator: SessionRecordLocator;
  /** Fork: the parent record whose prefix this one must prove, when there is no checkpoint. */
  parent?: { sessionId: string; locator: SessionRecordLocator };
  identity: RecordIdentity;
  committedOnly: boolean;
  /** The checkpoint file of the current generation, or `null` = read the record from its start. */
  checkpoint: string | null;
  /** Where to write the next generation. */
  checkpointOut: string;
  /** A private file for the turns that may be copied. */
  spill: string;
  /** Where copied pictures are written, one file per content hash (`record-ingest/root.ts`). */
  pictures: string;
  /**
   * Store rows, newest first. With a checkpoint: every row from the cursor's `storeSeq` on. Without: the newest
   * `STORE_TAIL` rows; `storeComplete` = they are all the rows there are.
   */
  stored: Array<{ seq: number; identity: WireIdentity }>;
  storeComplete: boolean;
  /** Record-backed rows without an outcome: a later read may complete them. */
  unfinished: Array<{ seq: number; identity: WireIdentity }>;
};

export type IngestSummary = {
  /**
   * `retry_full`: the checkpoint could not be used; call again without it. `need_store`: content matching needs every
   * store row (the tail was ambiguous); call again with all of them.
   */
  status: 'complete' | 'unchanged' | 'diverged' | 'unavailable' | 'retry_full' | 'need_store';
  /** The copied prefix is the whole record (an active turn was left out under `committedOnly`). */
  complete: boolean;
  lastSettled: boolean;
  /** Delivery ids in every turn of the record. */
  deliveryIds: string[];
  /** Turns to revise (`seq`) or append, in this order; read them with `next`. */
  revise: number;
  append: number;
  checkpointWritten: boolean;
  prunedDrops: number;
  resumed: boolean;
  /** The newest sent store row some record turn anchors: where the next ingest's store window starts. */
  recognizedSeq: number | null;
};

export type IngestBatch = { revise: Array<{ seq: number; turn: TranscriptTurn }>; append: TranscriptTurn[] };

/** The newest store rows sent when there is no checkpoint: the host's widest tail window before #resume-mem. */
export const STORE_TAIL = 200;
/** Above this a turn is copied with its pictures as sizes and its tool fields cut (`trimTurnsForTransport`). */
export const TURN_MAX_BYTES = 4 * 1024 * 1024;
const TRIMMED_FIELD_CHARS = 512 * 1024;
/**
 * Pictures copied into the store by one fill, as before resume-mem (`READ_BACK_MAX_CHARS`): past it a picture keeps
 * only its size. The store is read whole elsewhere on the host, so it must not grow by the record's pictures.
 */
export const FILL_PICTURE_CHARS = 256 * 1024 * 1024;
/** A batch is at most this many turns or bytes; the host holds one batch at a time. */
export const BATCH_MAX_TURNS = 64;
export const BATCH_MAX_BYTES = 4 * 1024 * 1024;

export const digest = (text: string): string => createHash('sha256').update(text).digest('base64url').slice(0, 16);
export const toWire = (identity: Identity): WireIdentity =>
  ({ keys: [...identity.keys], fingerprint: identity.fingerprint, prompt: identity.prompt });
const fromWire = (wire: WireIdentity): Identity => ({ keys: new Set(wire.keys), fingerprint: wire.fingerprint, prompt: wire.prompt });

type Checkpoint = { version: 1; archive: TimelineArchive; deliveryIds: string[] };
const CHECKPOINT_VERSION = 1;

export type IngestRun = { summary: IngestSummary; next(): Promise<IngestBatch | null>; close(): void };

export async function runIngest(request: IngestRequest, readRecord: typeof readRecordForIngest = readRecordForIngest): Promise<IngestRun> {
  const stored = request.stored.map((one) => fromWire(one.identity));
  const unfinished = request.unfinished.map((one) => ({ seq: one.seq, identity: fromWire(one.identity) }));
  const saved = request.checkpoint ? loadCheckpoint(request.checkpoint) : null;
  // The host's store window is the cursor's: without the checkpoint it belongs to, the read must start over.
  if (request.checkpoint && !saved) return { summary: { status: 'retry_full', complete: false, lastSettled: false, deliveryIds: [], revise: 0, append: 0, checkpointWritten: false, prunedDrops: 0, resumed: false, recognizedSeq: null }, next: async () => null, close: () => {} };
  const deliveries = new Set(saved?.deliveryIds ?? []);
  // Only what may be copied is spilled: from the first record turn the store tail (or an unfinished row) recognizes.
  // Any shared key, fingerprint or prompt counts (wider than `sameTurn`): starting the spill early only costs disk.
  const tailIds = { keys: new Set<string>(), texts: new Set<string>() };
  for (const one of [...stored.slice(0, saved ? stored.length : STORE_TAIL), ...unfinished.map((row) => row.identity)]) {
    for (const key of one.keys) tailIds.keys.add(key);
    for (const text of [one.fingerprint, one.prompt]) if (text !== null) tailIds.texts.add(text);
  }
  const mayCopy = (one: Identity) => [...one.keys].some((key) => tailIds.keys.has(key))
    || [one.fingerprint, one.prompt].some((text) => text !== null && tailIds.texts.has(text));
  const seen: Identity[] = [];
  let seenFrom = -1;
  let spillFrom = saved ? 0 : -1;
  let spillFd: number | null = openSync(request.spill, 'w');
  const closeSpill = () => { if (spillFd !== null) closeSync(spillFd); spillFd = null; };
  const offsets: number[] = [];
  let spillBytes = 0;

  const accept = (turn: TranscriptTurn, index: number) => {
    if (seenFrom < 0) seenFrom = index;
    const identity = hashIdentity(identify(turn), digest);
    seen.push(identity);
    for (const item of turn.items) {
      if (item.kind !== 'message' || item.role !== 'user') continue;
      for (const segment of readDeliveryEnvelope(item.text)?.segments ?? []) if (segment.facts?.messageId) deliveries.add(segment.facts.messageId);
    }
    if (spillFrom < 0 && mayCopy(identity)) spillFrom = index;
    if (spillFrom >= 0) spill(turn, index);
  };
  const spill = (turn: TranscriptTurn, index: number) => {
    let line = JSON.stringify(turn);
    if (line.length > TURN_MAX_BYTES) line = JSON.stringify(trimTurnsForTransport([turn], TRIMMED_FIELD_CHARS)[0]);
    const bytes = Buffer.from(`${JSON.stringify(index)}\t${line}\n`);
    offsets.push(spillBytes);
    writeSync(spillFd!, bytes);
    spillBytes += bytes.length;
  };

  let read: IngestRead;
  let lineage: readonly RecordLineageNode[] | undefined;
  try {
    if (request.parent && !saved) {
      const parent = await readRecord({ locator: request.parent.locator, sessionId: request.parent.sessionId, checkpoint: null, snapshot: true, onSettled: () => {} });
      lineage = parent.lineage ?? undefined;
      if (!lineage?.length) return finish(diverged());
    }
    read = await readRecord({
      locator: request.locator,
      sessionId: request.sessionId,
      checkpoint: saved?.archive ?? null,
      ...(lineage ? { parentLineage: lineage, snapshot: true } : {}),
      onSettled: (turns, from) => turns.forEach((turn, offset) => accept(turn, from + offset)),
    });
  } catch (error) {
    closeSpill();
    // No record to read is a fact about the session, not a failed ingest.
    if (error instanceof SessionRecordNotFoundError) return finish(summary('unavailable'));
    throw error;
  }
  if (saved && !read.resumed && read.status !== 'unchanged') return finish(summary('retry_full'));
  if (read.status === 'unchanged') {
    return finish({ ...summary('unchanged'), complete: true, lastSettled: true });
  }
  const active = read.tail.length > read.committed;
  const prefix = request.committedOnly && active ? read.tail.slice(0, read.committed) : read.tail;
  prefix.forEach((turn, offset) => accept(turn, read.tailFrom + offset));
  // The whole record, as `pickRecordTurns` saw it: `committedOnly` leaves an active last turn out.
  const lastSettled = !!prefix.at(-1)?.outcome;
  const complete = prefix.length === read.tail.length;

  // Revisions first, as before: a record turn that completes exactly one unfinished row.
  const revise = new Map<number, number>();
  for (let at = 0; at < seen.length; at += 1) {
    const hits = unfinished.filter((one) => matchAfterStore([seen[at]], [one.identity], request.identity)?.length === 0);
    if (hits.length > 1) return finish(diverged());
    if (hits.length === 1) revise.set(seenFrom + at, hits[0].seq);
  }
  let missing: number[] | null = null;
  // An empty record (or one whose only turn is still active under `committedOnly`) has nothing to copy.
  if (seen.length === 0) missing = [];
  else if (saved) {
    // The window's oldest row is the checkpoint's own turn (the cursor's `storeSeq`); older rows hold older record turns
    // and cannot disambiguate this window: it is complete for matching.
    missing = matchAfterStore(seen, stored, request.identity, { hasOlderStoredTurns: false });
    if (missing === null) return finish(summary('retry_full'));
  } else {
    const windows = request.identity === 'content' ? [10, 50, STORE_TAIL, Number.MAX_SAFE_INTEGER] : [10, 50, STORE_TAIL];
    for (const limit of windows) {
      if (limit > STORE_TAIL && !request.storeComplete && stored.length <= STORE_TAIL) return finish(summary('need_store'));
      const tail = stored.slice(0, limit);
      missing = matchAfterStore(seen, tail, request.identity, { hasOlderStoredTurns: tail.length === limit });
      if (missing !== null || tail.length < limit) break;
    }
  }
  if (missing === null) return finish(diverged());
  const append = new Set(missing.map((at) => seenFrom + at));
  for (const index of revise.keys()) append.delete(index);
  const wanted = new Set([...revise.keys(), ...append]);
  // The anchor can sit before the spill when the tail had no unique anchor: read the record once more for those turns.
  closeSpill();
  const recognizedSeq = newestRecognized();
  if ([...wanted].some((index) => spillFrom < 0 || index < spillFrom)) return rescan();
  return finish({ ...summary('complete'), complete, lastSettled, revise: revise.size, append: append.size, recognizedSeq }, read, { revise, append });

  function newestRecognized(): number | null {
    const keys = new Set<string>(), fingerprints = new Set<string>();
    for (const one of seen) {
      for (const key of one.keys) keys.add(key);
      if (one.fingerprint !== null) fingerprints.add(one.fingerprint);
    }
    const hit = request.stored.find((row, at) => [...stored[at].keys].some((key) => keys.has(key))
      || (stored[at].fingerprint !== null && fingerprints.has(stored[at].fingerprint!)));
    return hit?.seq ?? null;
  }

  async function rescan(recognizedSeq = newestRecognized()): Promise<IngestRun> {
    const fd = openSync(request.spill, 'w');
    offsets.length = 0;
    spillBytes = 0;
    const keep = (turn: TranscriptTurn, index: number) => {
      if (!revise.has(index) && !append.has(index)) return;
      let line = JSON.stringify(turn);
      if (line.length > TURN_MAX_BYTES) line = JSON.stringify(trimTurnsForTransport([turn], TRIMMED_FIELD_CHARS)[0]);
      writeSync(fd, `${JSON.stringify(index)}\t${line}\n`);
    };
    const again = await readRecord({
      locator: request.locator, sessionId: request.sessionId, checkpoint: null,
      ...(lineage ? { parentLineage: lineage, snapshot: true } : {}),
      onSettled: (turns, from) => turns.forEach((turn, offset) => keep(turn, from + offset)),
    });
    const tail = request.committedOnly && again.tail.length > again.committed ? again.tail.slice(0, again.committed) : again.tail;
    tail.forEach((turn, offset) => keep(turn, again.tailFrom + offset));
    closeSync(fd);
    return finish({ ...summary('complete'), complete, lastSettled, revise: revise.size, append: append.size, recognizedSeq }, read, { revise, append });
  }

  function summary(status: IngestSummary['status']): IngestSummary {
    return { status, complete: false, lastSettled: false, deliveryIds: [...deliveries], revise: 0, append: 0, checkpointWritten: false, prunedDrops: 0, resumed: !!saved, recognizedSeq: null };
  }
  function diverged(): IngestSummary {
    return summary('diverged');
  }
  function finish(out: IngestSummary, done?: IngestRead, plan?: { revise: Map<number, number>; append: Set<number> }): IngestRun {
    closeSpill();
    if (done) {
      out.prunedDrops = done.prunedDrops;
      out.resumed = done.resumed;
      if (done.checkpoint) {
        writeCheckpoint(request.checkpointOut, { version: CHECKPOINT_VERSION, archive: done.checkpoint, deliveryIds: out.deliveryIds });
        out.checkpointWritten = true;
      }
    }
    return { summary: out, ...batches(request.spill, request.pictures, plan) };
  }
}

/** Revised turns first, then appended ones, each in record order: the order the host wrote them in before. */
function batches(spill: string, pictures: string, plan?: { revise: Map<number, number>; append: Set<number> }): Pick<IngestRun, 'next' | 'close'> {
  const passes: Array<'revise' | 'append'> = plan ? ['revise', 'append'] : [];
  let lines: SpillLines | null = null;
  let carried: { kind: 'revise' | 'append'; seq?: number; turn: TranscriptTurn; bytes: number } | null = null;
  let budget = FILL_PICTURE_CHARS;
  // A picture within the fill's budget is written to its own file here; the turn the host stores keeps its size and hash.
  const store = (data: string): string => {
    const hash = createHash('sha256').update(data).digest('hex');
    mkdirSync(pictures, { recursive: true });
    const file = join(pictures, hash);
    if (!existsSync(file)) { writeFileSync(`${file}.part`, data); renameSync(`${file}.part`, file); }
    return hash;
  };
  const pull = (): typeof carried => {
    while (passes.length) {
      lines ??= spillLines(spill);
      const line = lines.next();
      if (line === null) { lines.close(); lines = null; passes.shift(); continue; }
      const tab = line.indexOf('\t');
      const index = Number(line.slice(0, tab));
      const kind = passes[0];
      if (kind === 'revise' ? !plan!.revise.has(index) : !plan!.append.has(index)) continue;
      const text = line.slice(tab + 1);
      const turn = JSON.parse(text) as TranscriptTurn;
      const kept = keepPictures(turn.items, (chars) => (budget -= chars) >= 0, store);
      return { kind, seq: plan!.revise.get(index), turn: kept === turn.items ? turn : { ...turn, items: kept }, bytes: text.length };
    }
    return null;
  };
  return {
    async next() {
      const batch: IngestBatch = { revise: [], append: [] };
      let bytes = 0, count = 0;
      for (;;) {
        const one = carried ?? pull();
        carried = null;
        if (!one) break;
        if (count > 0 && (count >= BATCH_MAX_TURNS || bytes + one.bytes > BATCH_MAX_BYTES)) { carried = one; break; }
        if (one.kind === 'revise') batch.revise.push({ seq: one.seq!, turn: one.turn });
        else batch.append.push(one.turn);
        bytes += one.bytes;
        count += 1;
      }
      return count ? batch : null;
    },
    close() {
      lines?.close();
      lines = null;
    },
  };
}

/**
 * Every picture leaves the turn as its size (`imageRefs`), as the transport projections show it. One the fill's budget
 * takes is stored to a file and keeps its hash (`storedImages`), read back by `getStoredToolImage`; past the budget a
 * picture keeps only its size, as before resume-mem.
 */
function keepPictures(items: TranscriptTurn['items'], take: (chars: number) => boolean, store: (data: string) => string): TranscriptTurn['items'] {
  let changed = false;
  const next = items.map((item) => {
    const node = item as unknown as { images?: Array<{ mimeType: string; data: string }>; children?: TranscriptTurn['items'] };
    let out = item;
    if (node.images?.length) {
      const { images, ...rest } = node;
      const kept = take(images.reduce((sum, image) => sum + image.data.length, 0));
      out = { ...rest, imageRefs: images.map(({ mimeType, data }) => ({ mimeType, chars: data.length })),
        ...(kept ? { storedImages: images.map(({ data }) => store(data)) } : {}) } as unknown as typeof item;
    }
    const children = (out as typeof node).children;
    const kept = children ? keepPictures(children, take, store) : children;
    if (kept !== children) out = { ...out, children: kept } as typeof item;
    if (out !== item) changed = true;
    return out;
  });
  return changed ? next : items;
}

type SpillLines = { next(): string | null; close(): void };

/** The spill's lines, read a chunk at a time and only as they are asked for: the spill can be gigabytes. */
function spillLines(path: string): SpillLines {
  const fd = openSync(path, 'r');
  const chunk = Buffer.alloc(1024 * 1024);
  let parts: Buffer[] = [];
  let position = 0;
  let done = false;
  return {
    next() {
      for (;;) {
        const pending = Buffer.concat(parts);
        const end = pending.indexOf(10);
        if (end >= 0) {
          parts = [pending.subarray(end + 1)];
          return pending.subarray(0, end).toString('utf8');
        }
        if (done) return pending.length ? (parts = [], pending.toString('utf8')) : null;
        const read = readSync(fd, chunk, 0, chunk.length, position);
        position += read;
        if (read === 0) done = true;
        else parts = [pending, Buffer.from(chunk.subarray(0, read))];
      }
    },
    close() { closeSync(fd); },
  };
}

function loadCheckpoint(path: string): Checkpoint | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Checkpoint;
    return parsed.version === CHECKPOINT_VERSION ? parsed : null;
  } catch {
    return null;
  }
}

function writeCheckpoint(path: string, checkpoint: Checkpoint): void {
  const temp = `${path}.tmp`;
  const fd = openSync(temp, 'w');
  try { writeSync(fd, JSON.stringify(checkpoint)); } finally { closeSync(fd); }
  renameSync(temp, path);
}
