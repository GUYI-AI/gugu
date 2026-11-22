import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { RecordEntry, SessionRecordLocator, SessionRecordResume } from '../contract';
import { createCodexJsonlSource, resolveRolloutFile } from './codex-jsonl';

const THREAD = '019ed98a-a0ce-7f63-a9aa-04e0760a80c2';
const FIRST = '019ed98b-0000-7000-8000-000000000001';
const SECOND = '019ed98c-0000-7000-8000-000000000002';
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); });
const line = (type: string, payload: object) => JSON.stringify({ timestamp: '2026-06-18T07:03:21Z', type, payload });
const text = (value: string) => line('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: value }] });
const turn = (value: string) => [line('event_msg', { type: 'task_started' }),
  line('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: `question ${value}` }] }),
  text(value), line('event_msg', { type: 'task_complete' })];
const encoded = (lines: string[]) => lines.join('\n') + '\n';
const meta = (history_base?: object) => line('session_meta', { id: THREAD, ...(history_base ? { history_base } : {}) });
const said = (entries: RecordEntry[]) => entries.flatMap(entry => entry.event?.kind === 'message' ? [entry.event.text] : []);

async function stage(depth = 2) {
  const root = await mkdtemp(join(tmpdir(), 'codex-segments-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const write = async (day: string, id: string, lines: string[]) => {
    const folder = join(root, '2026', '06', day);
    await mkdir(folder, { recursive: true });
    const file = join(folder, `rollout-2026-06-${day}T07-03-21-${id}.jsonl`);
    await writeFile(file, encoded(lines));
    return file;
  };
  const base = [meta(), ...turn('keep-原始')];
  const original = await write('18', THREAD, [...base, ...turn('discard-original')]);
  const firstPrefix = [meta({ thread_id: THREAD, end_ordinal_exclusive: base.length, end_byte_offset: Buffer.byteLength(encoded(base)) }), ...turn('keep-first')];
  const first = await write('19', `${THREAD}_${FIRST}`, [...firstPrefix, ...turn('discard-first')]);
  // The ordinal covers the whole chain; the byte offset covers only the first segment, including its own metadata.
  const secondLines = [meta({ thread_id: FIRST, end_ordinal_exclusive: base.length + firstPrefix.length,
    end_byte_offset: Buffer.byteLength(encoded(firstPrefix)) }), ...turn('keep-second')];
  const second = depth === 2 ? await write('20', `${THREAD}_${SECOND}`, secondLines) : null;
  const locator: SessionRecordLocator = { harness: 'codex', providerSessionId: THREAD, roots: [root] };
  return { root, locator, original, first, second, base, firstPrefix, secondLines };
}

async function start(locator: SessionRecordLocator, resume?: SessionRecordResume | null, fill = false) {
  const source = createCodexJsonlSource(locator, { fill, pollIntervalMs: 100_000 });
  cleanup.push(() => source.stop());
  const entries: RecordEntry[] = [], resets: string[] = [];
  await source.start({ onEntries: batch => entries.push(...batch), onReset: reason => { resets.push(reason); entries.length = 0; } }, resume ?? undefined);
  return { source, entries, resets };
}

describe('Codex history_base segments', () => {
  it('uses the newest segment across dates and roots, retaining exactly the selected ancestor prefix', async () => {
    const { locator, root, first, firstPrefix } = await stage(1);
    const segmentRoot = join(root, 'moved');
    await mkdir(segmentRoot);
    const moved = join(segmentRoot, first.split('/').at(-1)!);
    await writeFile(moved, encoded([...firstPrefix, ...turn('discard-first')]));
    await rm(first);
    locator.roots.push(segmentRoot);
    expect(await resolveRolloutFile(locator, false)).toBe(moved);
    const read = await start(locator);
    expect(said(read.entries)).toEqual(['question keep-原始', 'keep-原始', 'question keep-first', 'keep-first', 'question discard-first', 'discard-first']);
  });

  it("a fork's own rollout, plainly named, shows its parent up to the fork point, then its own turns", async () => {
    const { root } = await stage(1);
    const parent = '019ed98d-0000-7000-8000-000000000003', fork = '019ed98e-0000-7000-8000-000000000004';
    const folder = join(root, '2026', '06', '21');
    await mkdir(folder, { recursive: true });
    const kept = [line('session_meta', { id: parent }), ...turn('before-fork')];
    await writeFile(join(folder, `rollout-2026-06-21T07-03-21-${parent}.jsonl`), encoded([...kept, ...turn('parent-later')]));
    await writeFile(join(folder, `rollout-2026-06-21T08-03-21-${fork}.jsonl`), encoded([line('session_meta', { id: fork, forked_from_id: parent,
      history_base: { thread_id: parent, end_ordinal_exclusive: kept.length, end_byte_offset: Buffer.byteLength(encoded(kept)) } }), ...turn('forked')]));
    const { entries } = await start({ harness: 'codex', providerSessionId: fork, roots: [root] });
    expect(said(entries)).toEqual(['question before-fork', 'before-fork', 'question forked', 'forked']);
  });

  it('reads two successive reverts by per-file byte cutoffs, never treating the logical ordinal as a local line number', async () => {
    const { locator, second } = await stage();
    expect(await resolveRolloutFile(locator, false)).toBe(second);
    const { entries } = await start(locator);
    expect(said(entries)).toEqual(['question keep-原始', 'keep-原始', 'question keep-first', 'keep-first', 'question keep-second', 'keep-second']);
    expect(entries.filter(entry => entry.event?.kind === 'message' && entry.event.role === 'assistant').map(entry => entry.key))
      .toEqual([1, 2, 3].map(n => `codex:${THREAD}:${n}:2`));
    expect(new Set(entries.map(entry => entry.key)).size).toBe(entries.length);
  });

  it('gives seek positions only to the latest segment and resumes its tail with the chain decoder state', async () => {
    const { locator, second, secondLines } = await stage();
    const read = await start(locator, undefined, true);
    const prefix = read.entries.filter(entry => entry.event?.kind === 'message' && !entry.event.text.includes('second'));
    expect(prefix.length).toBeGreaterThan(0);
    expect(prefix.every(entry => entry.position === undefined)).toBe(true);
    const latest = read.entries.find(entry => entry.event?.kind === 'message' && entry.event.text === 'keep-second')!;
    expect(latest.position).toBe(Buffer.byteLength(encoded(secondLines.slice(0, 3))));
    const point = await read.source.resumePoint!();
    read.source.stop();
    await appendFile(second!, encoded(turn('appended')));
    const resumed = await start(locator, point);
    expect(resumed.resets).toEqual([]);
    expect(said(resumed.entries)).toEqual(['question appended', 'appended']);
    expect(resumed.entries.find(entry => entry.event?.kind === 'message' && entry.event.role === 'assistant')?.key).toBe(`codex:${THREAD}:4:2`);
  });

  it('invalidates a saved tail when another segment becomes current', async () => {
    const staged = await stage(1);
    const original = await start(staged.locator);
    const resume = await original.source.resumePoint!();
    original.source.stop();
    const newer = join(staged.root, `rollout-2026-06-20T07-03-21-${THREAD}_${SECOND}.jsonl`);
    await writeFile(newer, encoded(staged.secondLines));
    const reopened = await start(staged.locator, resume);
    expect(reopened.resets).toEqual(['source_replaced']);
    expect(said(reopened.entries)).toEqual(['question keep-原始', 'keep-原始', 'question keep-first', 'keep-first', 'question keep-second', 'keep-second']);
  });

  it('a revert while the record is tailed: catching up reads the new segment instead of the old file', async () => {
    const staged = await stage(1);
    const tailed = await start(staged.locator);
    expect(said(tailed.entries)).toContain('discard-first');
    await writeFile(join(staged.root, `rollout-2026-06-20T07-03-21-${THREAD}_${SECOND}.jsonl`), encoded(staged.secondLines));
    await tailed.source.catchUp!();
    expect(tailed.resets).toEqual(['source_replaced']);
    expect(said(tailed.entries)).toEqual(['question keep-原始', 'keep-原始', 'question keep-first', 'keep-first', 'question keep-second', 'keep-second']);
    // The new segment is tailed from then on.
    await appendFile(join(staged.root, `rollout-2026-06-20T07-03-21-${THREAD}_${SECOND}.jsonl`), encoded(turn('later')));
    await tailed.source.catchUp!();
    expect(said(tailed.entries).slice(-2)).toEqual(['question later', 'later']);
  });

  it('uses a segment without history_base as a complete record', async () => {
    const { locator, second } = await stage();
    await writeFile(second!, encoded([meta(), ...turn('standalone')]));
    expect(said((await start(locator)).entries)).toEqual(['question standalone', 'standalone']);
  });

  it('reads the same chain in snapshot mode without exposing a continuation point', async () => {
    const { locator } = await stage();
    const source = createCodexJsonlSource(locator, { readMode: 'snapshot', fill: true });
    cleanup.push(() => source.stop());
    const entries: RecordEntry[] = [];
    await source.start({ onEntries: batch => entries.push(...batch), onReset: () => {} });
    expect(said(entries)).toEqual(said((await start(locator)).entries));
    expect(await source.resumePoint?.()).toBeNull();
  });

  it('charges the retained ancestor bytes together with the latest tail before allowing an archive', async () => {
    const { locator, base, firstPrefix, secondLines } = await stage();
    const { source } = await start(locator);
    const bytes = Buffer.byteLength(encoded(base)) + Buffer.byteLength(encoded(firstPrefix)) + Buffer.byteLength(encoded(secondLines));
    expect(await source.resumePoint!({ remainingBytes: bytes - 1 })).toBeNull();
    const budget = { remainingBytes: bytes };
    expect(await source.resumePoint!(budget)).not.toBeNull();
    expect(budget.remainingBytes).toBe(0);
  });

  it.each(['missing', 'partial-line', 'past-end', 'cycle'])('fails a %s ancestor rather than presenting incomplete history', async kind => {
    const { locator, second } = await stage();
    const thread_id = kind === 'missing' ? 'missing-base' : kind === 'cycle' ? SECOND : THREAD;
    const end_byte_offset = kind === 'partial-line' ? 2 : kind === 'past-end' ? 1_000_000 : 0;
    await writeFile(second!, encoded([meta({ thread_id, end_byte_offset, end_ordinal_exclusive: 0 }), ...turn('new')]));
    await expect(start(locator)).rejects.toThrow();
  });
});
