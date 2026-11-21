import type {
  RecordEntry,
  SessionRecordLocator,
  SessionRecordResume,
  SessionRecordSource,
  SessionRecordSourceEvents
} from '../contract';
import { jsonlCheckAt, locateImages, readRecordImage } from './record-images';
import { emitJsonLines, pollInterval, warnOf, type SessionRecordSourceOptions } from './shared';
import { TailReader, type TailResume } from './tail-reader';
import { stat } from 'node:fs/promises';

/**
 * 一份只追加的 JSONL 文件的尾读源(codex、copilot):找到文件 → 整份读或接着续读点读 → 尾读。
 *
 * 各家只给:找文件、一条记录怎么解，以及(可选)随读随记、跟着续读点一起存的一份状态
 * (codex 的序号:它的条目 key 由「从头数到这里」派生)。
 */
export type JsonlTailFormat<S> = {
  /** 写进告警和 fingerprint 里的那一家。 */
  name: string;
  /** 续读点里这份数据的版本。形状或读法变了就升，老存档一律作废重读。 */
  resumeVersion: number;
  resolve(): Promise<string>;
  /** Immutable ancestors, each cut at its child's file-local byte boundary; only the resolved file is tail-followed. */
  prefixes?(path: string): Promise<ReadonlyArray<{ path: string; endByteOffset: number }>>;
  /** 从头读时的状态。文件被换掉、整份重读时回到它。 */
  initial(): S;
  /** 一条记录 → 条目;回 null = 坏行。`state` 可以就地改。 */
  decode(record: Record<string, unknown>, state: S): RecordEntry[] | null;
  /** A copy of `state` that later decoding cannot change (a fill read keeps one per line); default structuredClone. */
  snapshot?(state: S): S;
  /** The native children `state` already knows (`SessionRecordSource.childIdsAt`). */
  childIds?(state: S): string[];
  /**
   * A line changed what lines already read mean (a Codex rollback drops turns already sent): the state a read from the
   * start should begin with, carrying what was learned, or null. The source resets and reads the record again.
   */
  again?(state: S): S | null;
};

type ResumeData<S> = { version: number; path: string; tail: TailResume; state: S; prefixBytes?: number };

export function createJsonlTailSource<S>(
  locator: SessionRecordLocator,
  options: SessionRecordSourceOptions | undefined,
  format: JsonlTailFormat<S>
): SessionRecordSource {
  const warn = warnOf(options);
  let reader: TailReader | null = null;
  let path: string | null = null;
  let state = format.initial();
  let sink: SessionRecordSourceEvents | null = null;
  let stopped = false;
  let prefixBytes = 0;
  /** A whole read is running: a line asking for another read waits until it ends (`readWhole`). */
  let reading = false;

  const emit = (lines: string[], offsets: number[], file = path, seekable = true) => {
    if (stopped || !sink) return;
    const events = sink;
    emitJsonLines(lines, format.name, warn, (entries) => events.onEntries(entries), options?.fill ? decodeNoting : (record) => format.decode(record, state),
      file ? (entries, index) => locateImages(entries, lines[index], offsets[index], file) : undefined, seekable ? offsets : undefined);
    const next = reading ? null : format.again?.(state);
    if (next) void replay(next).catch((error: unknown) => warn('重读失败', { path, error: (error as Error).message }));
  };

  const open = (found: string): TailReader => {
    const mine: TailReader = new TailReader(
      found,
      pollInterval(options),
      {
        // A replaced reader may still be handing over lines it read before: they are read again by its successor.
        onLines: (lines, offsets) => { if (reader === mine) emit(lines, offsets); },
        onRestart: (reason) => {
          if (reader !== mine) return;
          state = format.initial();
          sink?.onReset(reason);
        }
      },
      warn,
      options?.fill
    );
    return mine;
  };

  /** Prefixes, then the record from its start; again while a line asks for it (`JsonlTailFormat.again`). */
  const readWhole = async (read: (reader: TailReader) => Promise<void>) => {
    reading = true;
    try {
      for (;;) {
        if (format.prefixes) await streamPrefixes(path!);
        await read(reader!);
        const next = stopped ? null : format.again?.(state);
        if (!next) return;
        sink?.onReset('source_replaced');
        state = next;
      }
    } finally { reading = false; }
  };

  /** A tailed line asked for another read: a fresh reader reads the record again, then tails it. */
  const replay = async (next: S) => {
    reader?.stop();
    sink?.onReset('source_replaced');
    state = next;
    reader = open(path!);
    await readWhole((fresh) => fresh.readFromStart(emit));
    reader?.start();
  };

  const streamPrefixes = async (found: string) => {
    prefixBytes = 0;
    for (const prefix of await format.prefixes?.(found) ?? []) {
      if (stopped) return;
      // Filled pictures in another file stay inline: a fill's picture locator belongs to the current record only.
      const prefixReader = new TailReader(prefix.path, pollInterval(options), { onLines: () => {}, onRestart: () => {} }, warn);
      try { await prefixReader.readPrefix(prefix.endByteOffset, (lines, offsets) => emit(lines, offsets, prefix.path, false)); }
      finally { prefixReader.stop(); }
      prefixBytes += prefix.endByteOffset;
    }
  };

  // A fill read: every entry carries the state its line was decoded from, so a later read can start at that line.
  const decodeNoting = (record: Record<string, unknown>) => {
    const before = format.snapshot ? format.snapshot(state) : structuredClone(state);
    const entries = format.decode(record, state);
    for (const entry of entries ?? []) entry.state = before;
    return entries;
  };

  const source: SessionRecordSource = {
    locator,
    async start(events, resume) {
      sink = events;
      const found = await format.resolve();
      if (stopped) return; // 找文件的工夫里已经被拆了
      path = found;
      reader = open(found);
      if (options?.readMode === 'snapshot') {
        if (resume) events.onReset('source_replaced');
        state = format.initial();
        await readWhole((whole) => whole.readSnapshot(emit));
        return;
      }
      const data = resume?.data as ResumeData<S> | undefined;
      const canResume = data?.version === format.resumeVersion && data.path === found;
      // 状态必须在 `resumeFrom` **之前**装回去:它当场就把「存档之后、重开之前」写进来的行读出来解码。
      // 先读后装 ⇒ 那一段按初始状态编号，键与存档里前几轮撞车，被上层去重表当成重复整条丢掉(#6357)。
      state = canResume ? structuredClone(data!.state) : format.initial();
      prefixBytes = canResume ? data!.prefixBytes ?? 0 : 0;
      let resumed = false;
      if (canResume) {
        reading = true;
        try { resumed = await reader.resumeFrom(data!.tail, emit); } finally { reading = false; }
      }
      const again = resumed ? format.again?.(state) : null;
      if (again) {
        events.onReset('source_replaced');
        state = again;
        await readWhole((whole) => whole.readFromStart(emit));
      } else if (!resumed) {
        // 要过存档、却没能续上 ⇒ 必须显式作废上层那份状态:不说的话整份重读会被旧去重表全部吃掉，
        // 留下一份过期且不再更新的历史。
        if (resume) events.onReset('source_replaced');
        state = format.initial();
        await readWhole((whole) => whole.readFromStart(emit));
      }
      reader?.start();
    },
    catchUp: async () => { if (options?.readMode !== 'snapshot') await reader?.catchUp(); },
    readImage: readRecordImage,
    // resume-tail: a plain JSONL record starts at a line start, with the decoder state a read had there (a fill read's
    // `RecordEntry.state`). A `.zst` archive (only found by a snapshot read) starts at its beginning.
    async startingAt(position, at) {
      const found = position > 0 ? await format.resolve().catch(() => null) : null;
      if (!found || found.endsWith('.zst')) return null;
      const info = await stat(found);
      const tail: TailResume = { ino: info.ino, size: info.size, mtimeMs: info.mtimeMs, lineOffset: position };
      const data: ResumeData<S> = { version: format.resumeVersion, path: found, tail, state: at === undefined ? format.initial() : at as S };
      return { data, fingerprint: `${format.name}:${found}:${tail.ino}:${tail.size}:${tail.mtimeMs}` } satisfies SessionRecordResume;
    },
    recordPath: () => format.resolve().catch(() => null),
    checkAt: async (position) => { const found = await format.resolve().catch(() => null); return found ? jsonlCheckAt(found, position) : null; },
    ...(format.childIds ? { childIdsAt: (at: unknown) => format.childIds!(at as S) } : {}),
    async stamp() {
      const found = await format.resolve().catch(() => null);
      if (!found) return null;
      const info = await stat(found);
      return `${found}:${info.ino}:${info.size}:${info.mtimeMs}`;
    },
    async resumePoint(budget) {
      if (!reader || !path || options?.readMode === 'snapshot') return null;
      // Debit before yielding/cloning; native children share this counter.
      const consumedBytes = reader.consumedBytes + prefixBytes;
      if (budget && (budget.remainingBytes -= consumedBytes) < 0) return null;
      const tail = await reader.resumePoint();
      if (!tail) return null;
      if (budget && (budget.remainingBytes -= Math.max(0, tail.lineOffset + prefixBytes - consumedBytes)) < 0) return null;
      const data: ResumeData<S> = { version: format.resumeVersion, path, tail, state: structuredClone(state), ...(prefixBytes ? { prefixBytes } : {}) };
      return { data, fingerprint: `${format.name}:${path}:${tail.ino}:${tail.size}:${tail.mtimeMs}` } satisfies SessionRecordResume;
    },
    stop() {
      stopped = true;
      reader?.stop();
      reader = null;
      sink = null;
    }
  };
  return source;
}
