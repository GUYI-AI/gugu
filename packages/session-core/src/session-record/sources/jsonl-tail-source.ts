import { createHash } from 'node:crypto';
import { open, stat } from 'node:fs/promises';
import type {
  RecordEntry,
  SessionRecordLocator,
  SessionRecordResume,
  SessionRecordSource,
  SessionRecordSourceEvents
} from '../contract';
import { locateImages, readRecordImage, snapshotRetainer } from './record-images';
import { emitJsonLines, pollInterval, warnOf, type SessionRecordSourceOptions } from './shared';
import { TailReader, type TailResume } from './tail-reader';

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
  /** 从头读时的状态。文件被换掉、整份重读时回到它。 */
  initial(): S;
  /** 一条记录 → 条目;回 null = 坏行。`state` 可以就地改。 */
  decode(record: Record<string, unknown>, state: S): RecordEntry[] | null;
};

/** `fence`: sha256 of the last decoded bytes before `tail.lineOffset`, set for a `.zst` snapshot (decoded offsets, as Codex counts them). */
type ResumeData<S> = { version: number; path: string; tail: TailResume; state: S; fence?: { bytes: number; sha256: string } };

const FENCE_BYTES = 4096;

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
  // Ingestion drains settled turns as it reads: the heap account for a reader that keeps everything does not apply.
  const retain = options?.readMode === 'snapshot' && !options.drained ? snapshotRetainer() : null;
  let emitFailure: { reason: unknown } | null = null;
  // A `.zst` snapshot has no file offsets; its resume point counts decoded bytes and proves them with the last few.
  let zstEnd = 0;
  let zstTail = Buffer.alloc(0);

  const emit = (lines: string[], offsets: number[]) => {
    if (stopped || !sink) return;
    const events = sink;
    const file = path;
    if (file?.endsWith('.zst') && lines.length) {
      // The fence is the longest byte-contiguous suffix (blank lines are not emitted), at most FENCE_BYTES.
      let from = lines.length - 1, bytes = Buffer.byteLength(lines[from]) + 1;
      while (from > 0 && bytes < FENCE_BYTES && offsets[from] === offsets[from - 1] + Buffer.byteLength(lines[from - 1]) + 1) {
        from -= 1;
        bytes += Buffer.byteLength(lines[from]) + 1;
      }
      const text = Buffer.from(lines.slice(from).map((line) => `${line}\n`).join(''));
      zstTail = Buffer.concat([offsets[from] === zstEnd ? zstTail : Buffer.alloc(0), text]).subarray(-FENCE_BYTES);
      zstEnd = offsets[lines.length - 1] + Buffer.byteLength(lines[lines.length - 1]) + 1;
    }
    try {
      emitJsonLines(lines, format.name, warn, (entries) => events.onEntries(entries), (record) => format.decode(record, state),
        file ? (entries, index) => (retain ? retain(entries, lines[index], offsets[index], file) : locateImages(entries, lines[index], offsets[index], file)) : undefined);
    } catch (reason) {
      emitFailure = { reason };
      throw reason;
    }
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
        warn
      );
      if (options?.readMode === 'snapshot') {
        if (resume) events.onReset('source_replaced');
        state = format.initial();
        await reader.readSnapshot(emit);
        return;
      }
      const data = resume?.data as ResumeData<S> | undefined;
      const canResume = data?.version === format.resumeVersion && data.path === found;
      // 状态必须在 `resumeFrom` **之前**装回去:它当场就把「存档之后、重开之前」写进来的行读出来解码。
      // 先读后装 ⇒ 那一段按初始状态编号，键与存档里前几轮撞车，被上层去重表当成重复整条丢掉(#6357)。
      state = canResume ? structuredClone(data!.state) : format.initial();
      const resumed = canResume ? await reader.resumeFrom(data!.tail, emit) : false;
      if (!resumed) {
        // 要过存档、却没能续上 ⇒ 必须显式作废上层那份状态:不说的话整份重读会被旧去重表全部吃掉，
        // 留下一份过期且不再更新的历史。
        if (resume) events.onReset('source_replaced');
        state = format.initial();
        await reader.readFromStart(emit);
      }
      reader.start();
    },
    catchUp: async () => { if (options?.readMode !== 'snapshot') await reader?.catchUp(); },
    readImage: readRecordImage,
    async resumePoint(budget) {
      // Only ingestion keeps a `.zst` resume point: its pictures are inline, so no interactive archive is written from one.
      if (path?.endsWith('.zst') && options?.readMode === 'snapshot' && options.drained) {
        if (!zstEnd || (budget && (budget.remainingBytes -= zstEnd) < 0)) return null;
        const info = await stat(path);
        const tail: TailResume = { ino: info.ino, size: info.size, mtimeMs: info.mtimeMs, lineOffset: zstEnd };
        const data: ResumeData<S> = { version: format.resumeVersion, path, tail, state: structuredClone(state), fence: { bytes: zstTail.length, sha256: digest(zstTail) } };
        return { data, fingerprint: `${format.name}:${path}:${tail.ino}:${tail.size}:${tail.mtimeMs}` } satisfies SessionRecordResume;
      }
      if (!reader || !path || options?.readMode === 'snapshot') return null;
      // Debit before yielding/cloning; native children share this counter.
      const consumedBytes = reader.consumedBytes;
      if (budget && (budget.remainingBytes -= consumedBytes) < 0) return null;
      const tail = await reader.resumePoint();
      if (!tail) return null;
      if (budget && (budget.remainingBytes -= Math.max(0, tail.lineOffset - consumedBytes)) < 0) return null;
      const data: ResumeData<S> = { version: format.resumeVersion, path, tail, state: structuredClone(state) };
      return { data, fingerprint: `${format.name}:${path}:${tail.ino}:${tail.size}:${tail.mtimeMs}` } satisfies SessionRecordResume;
    },
    stop() {
      stopped = true;
      reader?.stop();
      reader = null;
      sink = null;
    }
  };
  // A read that stops mid-stream can surface as a pipeline abort or the EBADF of its closed fd. Callers act on the reason.
  const start = source.start.bind(source);
  source.start = (events, resume) => start(events, resume).catch((error: unknown) => { throw emitFailure ? emitFailure.reason : error; });
  return source;
}

function digest(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

type ResumeTree = { nativeChildren?: number; root?: SessionRecordResume; children?: Record<string, SessionRecordResume> };

/** Each JSONL tail resume in a resume tree, through subagent wrappers (`withSubagentSources`). */
function jsonlResumes(resume: SessionRecordResume): Array<ResumeData<unknown>> {
  const tree = resume.data as ResumeTree;
  if (tree?.nativeChildren === 2) return [...(tree.root ? jsonlResumes(tree.root) : []), ...Object.values(tree.children ?? {}).flatMap(jsonlResumes)];
  return [resume.data as ResumeData<unknown>];
}

/** A `.zst` archive that has not changed since its resume point has nothing new: cold archives never grow. */
export async function zstResumeUnchanged(resume: SessionRecordResume): Promise<boolean> {
  const all = jsonlResumes(resume);
  if (!all.some((one) => one.path?.endsWith('.zst'))) return false;
  for (const one of all) {
    const info = await stat(one.path).catch(() => null);
    if (!info || info.ino !== one.tail.ino || info.size !== one.tail.size || info.mtimeMs !== one.tail.mtimeMs) return false;
    if (one.path.endsWith('.zst') && await stat(one.path.slice(0, -'.zst'.length)).then(() => true, () => false)) return false;
  }
  return true;
}

/**
 * Move `.zst` resume points to the plain `.jsonl` Codex materializes before appending (Codex
 * `codex-rs/rollout/src/compression.rs` `materialize_rollout_for_append_blocking`). Decoded offsets carry over;
 * the fence proves the plain file starts with the same bytes. `null` = some file cannot be proved: read it whole.
 */
export async function rebindZstResume(resume: SessionRecordResume): Promise<SessionRecordResume | null> {
  const rebind = async (data: ResumeData<unknown>): Promise<ResumeData<unknown> | null> => {
    if (!data.path?.endsWith('.zst')) return data;
    if (!data.fence) return null;
    const plain = data.path.slice(0, -'.zst'.length);
    const info = await stat(plain).catch(() => null);
    const length = data.fence.bytes;
    if (!info || info.size < data.tail.lineOffset || length === 0) return null;
    const handle = await open(plain, 'r');
    try {
      const bytes = Buffer.alloc(length);
      const { bytesRead } = await handle.read(bytes, 0, length, data.tail.lineOffset - length);
      if (bytesRead !== length || digest(bytes) !== data.fence.sha256) return null;
    } finally {
      await handle.close();
    }
    const { fence: _fence, ...rest } = data;
    return { ...rest, path: plain, tail: { ino: info.ino, size: info.size, mtimeMs: info.mtimeMs, lineOffset: data.tail.lineOffset } };
  };
  const walk = async (one: SessionRecordResume): Promise<SessionRecordResume | null> => {
    const tree = one.data as ResumeTree;
    if (tree?.nativeChildren === 2) {
      const root = tree.root ? await walk(tree.root) : undefined;
      if (root === null) return null;
      const children: Record<string, SessionRecordResume> = {};
      for (const [id, child] of Object.entries(tree.children ?? {})) {
        const next = await walk(child);
        if (!next) return null;
        children[id] = next;
      }
      return { ...one, data: { ...tree, root, children } };
    }
    const data = await rebind(one.data as ResumeData<unknown>);
    return data ? { ...one, data } : null;
  };
  return walk(resume);
}
