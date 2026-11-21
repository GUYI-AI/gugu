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
  /** A read from `start` is running: a line asking to read again waits for its end (`readAgain`). */
  let reading = false;
  /** What a read again starts from: `format.initial()` gives it while that read runs. */
  let seed: S | null = null;
  const initial = format.initial.bind(format);
  format = { ...format, initial: () => seed === null ? initial() : structuredClone(seed) };

  const emit = (lines: string[], offsets: number[], file = path, seekable = true) => {
    if (stopped || !sink) return;
    const events = sink;
    emitJsonLines(lines, format.name, warn, (entries) => events.onEntries(entries), options?.fill ? decodeNoting : (record) => format.decode(record, state),
      file ? (entries, index) => locateImages(entries, lines[index], offsets[index], file) : undefined, seekable ? offsets : undefined);
    if (!reading && format.again?.(state)) void whole(() => readAgain(events)).catch((error: unknown) => warn('重读失败', { path, error: (error as Error).message }));
  };

  const whole = async (read: () => Promise<void>) => {
    reading = true;
    try { await read(); } finally { reading = false; }
  };

  /** While a line asks for it (`JsonlTailFormat.again`): drop what was read, and read the record again through `start`. */
  const readAgain = async (events: SessionRecordSourceEvents) => {
    for (let next = format.again?.(state); next && !stopped; next = format.again?.(state)) {
      reader?.stop();
      events.onReset('source_replaced');
      seed = next;
      try { await start(events); } finally { seed = null; }
    }
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
      reader = new TailReader(
        found,
        pollInterval(options),
        {
          onLines: emit,
          onRestart: (reason) => {
            state = format.initial();
            events.onReset(reason);
          }
        },
        warn,
        options?.fill
      );
      if (options?.readMode === 'snapshot') {
        if (resume) events.onReset('source_replaced');
        state = format.initial();
        if (format.prefixes) await streamPrefixes(found);
        await reader.readSnapshot(emit);
        return;
      }
      const data = resume?.data as ResumeData<S> | undefined;
      const canResume = data?.version === format.resumeVersion && data.path === found;
      // 状态必须在 `resumeFrom` **之前**装回去:它当场就把「存档之后、重开之前」写进来的行读出来解码。
      // 先读后装 ⇒ 那一段按初始状态编号，键与存档里前几轮撞车，被上层去重表当成重复整条丢掉(#6357)。
      state = canResume ? structuredClone(data!.state) : format.initial();
      prefixBytes = canResume ? data!.prefixBytes ?? 0 : 0;
      const resumed = canResume ? await reader.resumeFrom(data!.tail, emit) : false;
      if (!resumed) {
        // 要过存档、却没能续上 ⇒ 必须显式作废上层那份状态:不说的话整份重读会被旧去重表全部吃掉，
        // 留下一份过期且不再更新的历史。
        if (resume) events.onReset('source_replaced');
        state = format.initial();
        if (format.prefixes) await streamPrefixes(found);
        await reader.readFromStart(emit);
      }
      reader.start();
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
  // A whole read (initial, snapshot or resume) ends first; only then is the record read again, at most once more.
  const start = source.start.bind(source);
  source.start = (events, resume) => whole(async () => {
    await start(events, resume);
    await readAgain(events);
  });
  return source;
}
