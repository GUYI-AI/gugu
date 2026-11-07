import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { assertPathInScanRoots } from '@gugu/core/local/agent/transcriptInventory';
import { requireTranscriptSourceSpec } from '@gugu/core/local/agent/transcriptSources/index';
import type { TranscriptScanOptions } from '@gugu/core/local/agent/transcriptSource';
import type { ImportedTranscriptTurn } from '@gugu/core/shared/types/transcripts';
import { openWindowByteSource } from '@gugu/session-core/session-record/window-cache/file-source';
import { readBytePage } from '@gugu/session-core/session-record/window-cache/byte-page';
import { readJsonlWindow } from '@gugu/session-core/session-record/window-cache/jsonl-window';
import { syncWindowDirectory } from '@gugu/session-core/session-record/window-cache/disk-frame';
import { createWindowBudget } from '@gugu/session-core/session-record/window-cache/read-budget';
import { saveReverseIndexTask, loadReverseIndexTask } from '@gugu/session-core/session-record/window-cache/record-locators';
import { sourceLocatorScope, writeSourceLocator } from '@gugu/session-core/session-record/window-cache/source-locator';
import type { PendingLongRecord, ReverseCheckpoint } from '@gugu/session-core/session-record/window-cache/types';
import { transcriptPrefixMetadata } from './transcript-prefix-metadata';

const clip = (turn: ImportedTranscriptTurn) => ({ ...turn, content: turn.content.length > 400 ? `${turn.content.slice(0, 400)}…` : turn.content });

/** Import binds an existing file. It may inspect pages, never scan a preparation pass. */
export async function readBoundedLocalSessionPreview(userDataPath: string, params: { filePath: string; engine: 'claude-code' | 'codex' },
  options: TranscriptScanOptions & { signal?: AbortSignal },
  schedule?: (path: string, checkpoint: ReverseCheckpoint, directory: string, scope: string) => void) {
  const spec = requireTranscriptSourceSpec(params.engine);
  await assertPathInScanRoots(params.filePath, spec, options);
  const source = await openWindowByteSource(params.filePath), budget = createWindowBudget();
  try {
    const snapshot = await source.snapshot();
    const head = await readBytePage(source, { budget, signal: options.signal,
      cursor: { ...snapshot, before: Math.min(snapshot.size, 64 * 1024) } });
    if (head.kind === 'reset') throw new Error('Native source changed during preview');
    budget.charge('decodedBytes', head.bytes.length);
    const text = Buffer.from(head.bytes).toString('utf8'), metadata = transcriptPrefixMetadata(text, params.engine);
    let title: string | undefined, explicitUserTitle = false, providerSessionId = metadata.providerSessionId, cwd = metadata.cwd ?? null;
    const headTurns: ImportedTranscriptTurn[] = [], lines = text.split('\n');
    const completeHead = head.end === snapshot.size && lines.length <= 64;
    const absorb = (line: string, turns: ImportedTranscriptTurn[]) => {
      if (!line.trim()) return;
      budget.charge('examinedRecords', 1);
      const entry = JSON.parse(line) as Record<string, unknown>, frame = spec.readFrame(entry);
      if (!frame || frame.sidechain) return;
      providerSessionId ??= frame.providerSessionId; cwd ??= frame.cwd ?? null;
      if (frame.explicitTitle && (!explicitUserTitle || frame.explicitTitleIsUserSet)) {
        title = frame.explicitTitle; explicitUserTitle = !!frame.explicitTitleIsUserSet;
      }
      if (frame.turn) { title ??= frame.turn.content.slice(0, 120); turns.push(clip(frame.turn)); }
    };
    const count = Math.min(lines.length, 64);
    for (let index = 0; index < count; index++) {
      options.signal?.throwIfAborted();
      if (index === lines.length - 1 && head.end !== snapshot.size) break;
      absorb(lines[index], headTurns);
    }
    const tailTurns: ImportedTranscriptTurn[] = [], pendingLongRecords: PendingLongRecord[] = [];
    let fragment: { recordEnd: number; scanBefore: number } | null = null;
    if (!completeHead) {
      const tail = await readJsonlWindow(source, { budget, signal: options.signal, limit: 64 });
      if (tail.kind === 'reset') throw new Error('Native source changed during preview');
      if (tail.snapshot.snapshotRevision !== snapshot.snapshotRevision) throw new Error('Native source changed during preview');
      fragment = tail.headFragment;
      for (const record of [...tail.records].reverse()) {
        budget.charge('decodedBytes', record.bytes.length);
        // readJsonlWindow already charged this envelope, so only the decoder is called here.
        const frame = spec.readFrame(JSON.parse(Buffer.from(record.bytes).toString('utf8')) as Record<string, unknown>);
        if (frame?.explicitTitle && (!explicitUserTitle || frame.explicitTitleIsUserSet)) {
          title = frame.explicitTitle; explicitUserTitle = !!frame.explicitTitleIsUserSet;
        }
        if (frame?.turn && !frame.sidechain) tailTurns.push(clip(frame.turn));
      }
    }
    if (!providerSessionId) throw new Error('Native session metadata is not located in the preview page');
    const harness = params.engine === 'claude-code' ? 'claude' : 'codex';
    const cacheDirectory = join(userDataPath, 'session-window-cache');
    await mkdir(cacheDirectory, { recursive: true }); await syncWindowDirectory(userDataPath);
    await writeSourceLocator(cacheDirectory, { version: 1, harness, providerSessionId, path: params.filePath,
      source: snapshot, sourceLineage: snapshot.sourceInstance });
    if (fragment) {
      const scope = sourceLocatorScope(harness, providerSessionId);
      const jobId = createHash('sha256').update(`${snapshot.sourceInstance}:${fragment.recordEnd}`).digest('hex');
      let fence = new Uint8Array(0), read = 0, failed = false, failure: unknown;
      const fenceLength = Math.min(64, snapshot.size), fenceStart = snapshot.size - fenceLength;
      await budget.read('sourceBytes', fenceLength, async () => {
        fence = new Uint8Array(fenceLength);
        try {
          while (read < fenceLength && !options.signal?.aborted) {
            const count = await source.read(fence, read, fenceLength - read, fenceStart + read);
            if (!count) break;
            read += count;
          }
        } catch (error) { failed = true; failure = error; }
        return read;
      });
      if (failed) throw failure;
      options.signal?.throwIfAborted();
      if (read !== fenceLength) throw new Error('Native source changed during preview');
      const checkpoint: ReverseCheckpoint = { version: 1, jobId, sourceId: snapshot.sourceId, sourceInstance: snapshot.sourceInstance,
        sourceLineage: snapshot.sourceInstance, snapshotRevision: snapshot.snapshotRevision, pinnedEnd: snapshot.size,
        recordEnd: fragment.recordEnd, scanBefore: fragment.scanBefore,
        sourceFence: { start: fenceStart, end: snapshot.size, digest: createHash('sha256').update(fence).digest('hex') } };
      const directory = join(cacheDirectory, 'source-locators');
      const job = { scope, sourceLineage: checkpoint.sourceLineage, decoderVersion: 1, jobId };
      const saved = await loadReverseIndexTask(directory, job, budget);
      const reusable = saved.kind === 'hit' && saved.position.checkpoint.snapshotRevision === snapshot.snapshotRevision;
      if (!reusable) await saveReverseIndexTask(directory, job, { kind: 'scanning', checkpoint });
      const current = reusable && saved.kind === 'hit' ? saved.position.checkpoint : checkpoint;
      if (!reusable || saved.kind !== 'hit' || saved.position.kind !== 'located') {
        pendingLongRecords.push({ kind: 'pending_long_record', ticket: jobId, sourceInstance: snapshot.sourceInstance,
          pinnedEnd: snapshot.size, nextScanOffset: current.scanBefore, sourceFence: current.sourceFence });
        schedule?.(params.filePath, current, directory, scope);
      }
    }
    options.signal?.throwIfAborted();
    if ((await source.snapshot()).snapshotRevision !== snapshot.snapshotRevision) throw new Error('Native source changed during preview');
    const result = { providerSessionId, title: title ?? '（无标题会话）', cwd,
      turnCount: completeHead ? headTurns.length : null,
      head: headTurns.slice(0, 3), tail: completeHead ? headTurns.slice(Math.max(3, headTurns.length - 3)) : tailTurns.slice(-3), pendingLongRecords };
    budget.charge('outputBytes', Buffer.byteLength(JSON.stringify(result)));
    return result;
  } finally { await source.close(); }
}
