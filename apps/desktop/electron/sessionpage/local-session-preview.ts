import { basename } from 'node:path';
import { assertPathInScanRoots, newDigest, absorbFrame, readFrame, parseJsonLine } from '@gugu/core/local/agent/transcriptInventory';
import { requireTranscriptSourceSpec } from '@gugu/core/local/agent/transcriptSources/index';
import type { ImportedTranscriptTurn, TranscriptSource, TranscriptScanOptions } from '@gugu/core';
import { openWindowByteSource } from '@gugu/session-core/session-record/window-cache/file-source';
import { readBytePage, WINDOW_FRAME_BYTES } from '@gugu/session-core/session-record/window-cache/byte-page';
import { readJsonlWindow } from '@gugu/session-core/session-record/window-cache/jsonl-window';
import { createWindowBudget, WINDOW_LIMITS } from '@gugu/session-core/session-record/window-cache/read-budget';
import { transcriptPrefixMetadata } from './transcript-prefix-metadata';

export type LocalPreviewRequest = { filePath: string; engine: TranscriptSource; scanOptions: TranscriptScanOptions };
export type BoundedLocalPreview = Awaited<ReturnType<typeof readBoundedLocalSessionPreview>>;
const TURNS = 3, CHARS = 400, RECORDS = 64;
const clip = (turn: ImportedTranscriptTurn): ImportedTranscriptTurn => ({ ...turn,
  content: turn.content.length > CHARS ? `${turn.content.slice(0, CHARS)}…` : turn.content });

/** Runs on the preview thread. Two physical pages, never a prefix replay/count pass. */
export async function readBoundedLocalSessionPreview(request: LocalPreviewRequest, signal?: AbortSignal) {
  const { filePath, engine, scanOptions } = request;
  signal?.throwIfAborted();
  const spec = requireTranscriptSourceSpec(engine);
  await assertPathInScanRoots(filePath, spec, scanOptions);
  signal?.throwIfAborted();
  const source = await openWindowByteSource(filePath);
  const budget = createWindowBudget({ ...WINDOW_LIMITS, sourceBytes: WINDOW_FRAME_BYTES * 2, outputBytes: 32 * 1024 });
  try {
    const snapshot = await source.snapshot();
    const head = await readBytePage(source, { budget, signal, cursor: { ...snapshot, before: Math.min(snapshot.size, WINDOW_FRAME_BYTES) } });
    if (head.kind === 'reset') throw new Error('Native source changed during preview');
    budget.charge('decodedBytes', head.bytes.length);
    const text = Buffer.from(head.bytes).toString('utf8');
    const digest = newDigest();
    // A giant first metadata record need not be parsed (or even finish) to
    // recover completed identity scalars. Never infer identity from body text.
    if (!text.includes('\n') && head.end < snapshot.size) Object.assign(digest, transcriptPrefixMetadata(text, engine));
    const turns: Array<{ start: number; turn: ImportedTranscriptTurn }> = [];
    let recordStart = 0, examined = 0, headComplete = true;
    const absorb = (line: string, start: number) => {
      const entry = parseJsonLine(line);
      if (!entry) return;
      const frame = readFrame(spec, entry);
      if (!frame || frame.sidechain) return;
      absorbFrame(digest, frame);
      if (frame.turn) turns.push({ start, turn: clip(frame.turn) });
    };
    // Split complete records only. An unfinished UTF-8 character or JSON body
    // at this page's edge never becomes replacement text or a fabricated turn.
    for (let index = 0; index <= head.bytes.length; index++) {
      signal?.throwIfAborted();
      const eof = index === head.bytes.length;
      if (eof && head.end !== snapshot.size) { headComplete = false; break; }
      if (!eof && head.bytes[index] !== 10) continue;
      if (index > recordStart) {
        if (examined === RECORDS) { headComplete = false; break; }
        budget.charge('examinedRecords', 1); examined++;
        absorb(Buffer.from(head.bytes.subarray(recordStart, index)).toString('utf8'), recordStart);
      }
      recordStart = index + 1;
    }
    const complete = headComplete && head.end === snapshot.size;
    const headTurns = turns.slice(0, TURNS);
    let tailTurns = turns.slice(Math.max(TURNS, turns.length - TURNS));
    let oversizedTail = false;
    if (!complete) {
      const tail = await readJsonlWindow(source, { budget, signal, limit: RECORDS });
      if (tail.kind === 'reset' || tail.snapshot.snapshotRevision !== snapshot.snapshotRevision) throw new Error('Native source changed during preview');
      oversizedTail = tail.headFragment !== null;
      const tailStart = turns.length;
      for (const record of [...tail.records].reverse()) {
        budget.charge('decodedBytes', record.bytes.length);
        absorb(Buffer.from(record.bytes).toString('utf8'), record.range.start);
      }
      // The physical windows can overlap: identity is the byte start, not text.
      const shown = new Set(headTurns.map(one => one.start));
      tailTurns = turns.slice(tailStart).filter(one => !shown.has(one.start)).slice(-TURNS);
    }
    signal?.throwIfAborted();
    if ((await source.snapshot()).snapshotRevision !== snapshot.snapshotRevision) throw new Error('Native source changed during preview');
    if (!digest.providerSessionId && !complete) throw new Error('预览窗口内未找到原会话身份，不能猜测恢复目标');
    if (complete && turns.length === 0) throw new Error(`transcript 中没有可导入的用户/助手对话：${filePath}`);
    const result = { providerSessionId: digest.providerSessionId ?? basename(filePath, spec.fileExtension),
      title: digest.title ?? '（无标题会话）', cwd: digest.cwd,
      turnCount: complete ? turns.length : null,
      incomplete: !complete, oversizedTail,
      head: headTurns.map(one => one.turn), tail: tailTurns.map(one => one.turn) };
    // Include the accounting envelope itself; only the bounded response is
    // encoded, never a full transcript transported out of the worker.
    const accounted = { ...result, io: { ...budget.counters } };
    for (let iteration = 0; iteration < 3; iteration++) accounted.io.outputBytes = Buffer.byteLength(JSON.stringify(accounted));
    budget.charge('outputBytes', accounted.io.outputBytes);
    return { ...result, io: budget.counters };
  } finally { await source.close(); }
}
