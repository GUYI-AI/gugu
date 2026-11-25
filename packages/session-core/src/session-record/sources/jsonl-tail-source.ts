import type {
  RecordEntry,
  SessionRecordLocator,
  SessionRecordResume,
  SessionRecordSource,
  SessionRecordSourceEvents
} from '../contract';
import { jsonlCheckAt, locateImages } from './record-images';
import { initialTree, keepNode, markTurn, type RecordNode, type TreeState } from './record-tree';
import { emitJsonLines, pollInterval, warnOf, type SessionRecordSourceOptions } from './shared';
import { TailReader, type TailResume } from './tail-reader';
import { stat } from 'node:fs/promises';
import type { CodexRecordEvents } from './codex-record-events';

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
  /** Native event owner for formats that must never start TailReader's polling driver. */
  watch?(failed: (error: unknown) => void): CodexRecordEvents;
  /**
   * The record can go on in another file (a Codex revert writes a new segment): catching up looks for it again, and a
   * record found elsewhere is read anew from there.
   */
  continuesElsewhere?: true;
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
   * What a record is on the conversation tree (`record-tree.ts`), or null for a line that is not on it. Called before
   * `decode`, on every line; a line on an abandoned branch is then not decoded at all.
   */
  node?(record: Record<string, unknown>, state: S): RecordNode | null;
};

/** The format's own state and the tree's, read and resumed together. */
type Tracked<S> = { format: S; tree: TreeState };

type ResumeData<S> = { version: number; path: string; tail: TailResume; state: Tracked<S>; prefixBytes?: number };

export function createJsonlTailSource<S>(
  locator: SessionRecordLocator,
  options: SessionRecordSourceOptions | undefined,
  adapter: JsonlTailFormat<S>
): SessionRecordSource {
  const warn = warnOf(options);
  let reader: TailReader | null = null;
  let path: string | null = null;
  /** What a read again starts from: `format.initial()` gives it while that read runs. */
  let seed: Tracked<S> | null = null;
  const format = tracked(adapter, () => seed);
  let state = format.initial();
  let sink: SessionRecordSourceEvents | null = null;
  let stopped = false;
  let prefixBytes = 0;
  /** A read from `start` is running: a fork it finds is read again once it ends (`readAgain`). */
  let reading = false;
  /** A read again that a tailed fork started; `catchUp` waits for it. */
  let again: Promise<void> | null = null;
  let recordEvents: CodexRecordEvents | null = null;
  let failure: unknown;
  const failed = (error: unknown) => {
    failure = error;
    recordEvents?.stop();
    reader?.stop();
    sink?.onError?.(error);
  };

  const emit = (lines: string[], offsets: number[], file = path, seekable = true) => {
    if (stopped || !sink) return;
    const events = sink;
    emitJsonLines(lines, format.name, warn, (entries) => events.onEntries(entries), options?.fill ? decodeNoting : (record) => format.decode(record, state),
      file ? (entries, index) => locateImages(entries, lines[index], offsets[index], file) : undefined, seekable ? offsets : undefined);
    if (!reading && format.again(state)) {
      again = whole(() => readAgain(events)).catch((error: unknown) => {
        if (adapter.watch) failed(error);
        else warn('重读失败', { path, error: (error as Error).message });
      });
    }
  };

  const whole = async (read: () => Promise<void>) => {
    reading = true;
    try { await read(); } finally { reading = false; }
  };

  /** While a read found a fork it did not know: drop what was read, and read the record again through `start`. */
  const readAgain = async (events: SessionRecordSourceEvents) => {
    for (let next = format.again(state); next && !stopped; next = format.again(state)) {
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
      recordEvents?.stop();
      recordEvents = options?.readMode === 'snapshot' ? null : adapter.watch?.(failed) ?? null;
      let found: string;
      try {
        await recordEvents?.ready();
        found = await format.resolve();
        await recordEvents?.includeFile(found);
      } catch (error) { recordEvents?.stop(); throw error; }
      if (stopped) return; // 找文件的工夫里已经被拆了
      path = found;
      reader = new TailReader(
        found,
        pollInterval(options),
        {
          onLines: emit,
          ...(adapter.watch ? { onError: failed } : {}),
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
      if (failure !== undefined) throw failure;
      if (recordEvents) recordEvents.activate(async (locateAgain) => {
        if (locateAgain) await source.catchUp?.();
        else { await reader?.catchUp(); await again; }
      });
      else reader.start();
    },
    catchUp: async () => {
      if (options?.readMode === 'snapshot') return;
      if (adapter.continuesElsewhere && sink && path && !reading) {
        const events = sink;
        const found = await format.resolve().catch(() => null);
        if (found && found !== path && !stopped) {
          reader?.stop();
          events.onReset('source_replaced');
          await source.start(events);
          return;
        }
      }
      await reader?.catchUp();
      await again;
    },
    // resume-tail: a plain JSONL record starts at a line start, with the decoder state a read had there (a fill read's
    // `RecordEntry.state`). A `.zst` archive (only found by a snapshot read) starts at its beginning.
    async startingAt(position, at) {
      const found = position > 0 ? await format.resolve().catch(() => null) : null;
      if (!found || found.endsWith('.zst')) return null;
      const info = await stat(found);
      const tail: TailResume = { ino: info.ino, size: info.size, mtimeMs: info.mtimeMs, lineOffset: position };
      const data: ResumeData<S> = { version: format.resumeVersion, path: found, tail, state: at === undefined ? format.initial() : at as Tracked<S> };
      return { data, fingerprint: `${format.name}:${found}:${tail.ino}:${tail.size}:${tail.mtimeMs}` } satisfies SessionRecordResume;
    },
    recordPath: () => format.resolve().catch(() => null),
    checkAt: async (position) => { const found = await format.resolve().catch(() => null); return found ? jsonlCheckAt(found, position) : null; },
    ...(format.childIds ? { childIdsAt: (at: unknown) => format.childIds!(at as Tracked<S>) } : {}),
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
      recordEvents?.stop();
      reader?.stop();
      reader = null;
      sink = null;
    }
  };
  // A whole read (initial, snapshot or resume) ends first; only then is the record read again, at most once more.
  const start = source.start.bind(source);
  source.start = (events, resume) => whole(async () => {
    try {
      await start(events, resume);
      await readAgain(events);
    } catch (error) { recordEvents?.stop(); reader?.stop(); throw error; }
  });
  return source;
}

/** The adapter with the tree in front of it: a line on an abandoned branch makes no entries. */
function tracked<S>(adapter: JsonlTailFormat<S>, seed: () => Tracked<S> | null) {
  const { node, snapshot, childIds } = adapter;
  return {
    name: adapter.name,
    resumeVersion: adapter.resumeVersion,
    resolve: () => adapter.resolve(),
    ...(adapter.prefixes ? { prefixes: adapter.prefixes.bind(adapter) } : {}),
    initial: (): Tracked<S> => structuredClone(seed()) ?? { format: adapter.initial(), tree: initialTree() },
    decode(record: Record<string, unknown>, state: Tracked<S>): RecordEntry[] | null {
      const line = node?.(record, state.format) ?? null;
      if (line && !keepNode(state.tree, line)) return [];
      const entries = adapter.decode(record, state.format);
      return line && entries ? markTurn(entries, line) : entries;
    },
    snapshot: (state: Tracked<S>): Tracked<S> =>
      ({ format: snapshot ? snapshot(state.format) : structuredClone(state.format), tree: { ...state.tree } }),
    ...(childIds ? { childIds: (state: Tracked<S>) => childIds(state.format) } : {}),
    /** A read found a fork it did not know: the state to read again from, knowing every fork found so far. */
    again: (state: Tracked<S>): Tracked<S> | null =>
      state.tree.fresh ? { format: adapter.initial(), tree: initialTree(state.tree.forks) } : null,
  };
}
