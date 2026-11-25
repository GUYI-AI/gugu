import { appendFile, mkdir, mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { awaitFact, awaitPending } from '../../../../../tests/support/awaitFact';
import { SessionRecordNotFoundError } from './shared';
import type { TranscriptTurn } from '../../acp/models/turns/turn';
import { createCodexJsonlSource } from './codex-jsonl';
import { createSessionTimeline } from '../timeline';

const directoryDelivery = vi.hoisted(() => ({ enabled: true }));
vi.mock('../../services/fs-watch/impl/directory-watch', async (load) => {
  const { DirectoryWatch } = await load<typeof import('../../services/fs-watch/impl/directory-watch')>();
  return {
    DirectoryWatch: class extends DirectoryWatch {
      constructor(...[root, deliver, resync, onError, recover]: ConstructorParameters<typeof DirectoryWatch>) {
        super(root, events => { if (directoryDelivery.enabled) deliver(events); },
          () => { if (directoryDelivery.enabled) resync(); }, onError, recover);
      }
    },
  };
});

const THREAD = '01a20e21-ffaf-7ff0-ac0b-9cda461fa5b3';
const line = (type: string, payload: object) => JSON.stringify({ type, payload }) + '\n';
const meta = line('session_meta', { id: THREAD });
const message = (role: 'user' | 'assistant', text: string) => line('response_item', {
  type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }],
});
const turnLines = (id: string, prompt: string, ...replies: string[]) => line('event_msg', { type: 'task_started', turn_id: id })
  + message('user', prompt) + replies.map(reply => message('assistant', reply)).join('') + line('event_msg', { type: 'task_complete', turn_id: id });
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { vi.useRealTimers(); directoryDelivery.enabled = true; while (cleanups.length) await cleanups.pop()!(); });
async function setup(missing = false) {
  const temp = await mkdtemp(join(tmpdir(), 'codex-record-events-'));
  cleanups.push(() => rm(temp, { recursive: true, force: true }));
  const root = missing ? join(temp, 'agent', 'sessions') : temp;
  const file = join(root, '2026', '11', '24', `rollout-${THREAD}.jsonl`);
  const locator = { harness: 'codex' as const, providerSessionId: THREAD, roots: [root] };
  const create = async (data = meta) => { await mkdir(dirname(file), { recursive: true }); await writeFile(file, data); };
  return { root, file, locator, create };
}

/** The runtime's turn in progress, as its host syncs it into the timeline. */
const live = (id: string, prompt: string, startedAt: number, ...replies: string[]): TranscriptTurn => ({
  id, seq: 0, initiator: 'user', startedAt,
  items: [
    { kind: 'message', id: `${id}:message:u`, seq: 0, role: 'user', text: prompt },
    ...replies.map((text, index) => ({ kind: 'message' as const, id: `${id}:message:a${index}`, seq: index + 1, role: 'assistant' as const, text })),
  ],
} as TranscriptTurn);
const texts = (turns: readonly TranscriptTurn[]) => turns.map(turn => turn.items.flatMap(item => item.kind === 'message' ? [item.text] : []));

/** A timeline of a session whose record is not written yet, with every state it publishes. */
async function awaitingTimeline(s: Awaited<ReturnType<typeof setup>>, sessionId: string) {
  const onError = vi.fn();
  const timeline = await createSessionTimeline(createCodexJsonlSource(s.locator), { sessionId, onError });
  cleanups.push(() => timeline.dispose());
  const published: string[][][] = [];
  cleanups.push(timeline.subscribe(timeline.getSnapshot().cursor, () => published.push(texts(timeline.getSnapshot().turns))));
  const shows = (step: string, expected: string[][]) => awaitFact(step, () =>
    JSON.stringify(texts(timeline.getSnapshot().turns)) === JSON.stringify(expected) ? true : undefined);
  return { timeline, published, shows, onError };
}

describe('a Codex record not written yet', () => {
  it('opens its timeline with no entries, and reads the record when a directory notification says it is there', async () => {
    const s = await setup(true);
    const poll = vi.spyOn(globalThis, 'setInterval');
    cleanups.push(() => poll.mockRestore());
    const { shows } = await awaitingTimeline(s, 'codex-awaited');
    await s.create(meta + turnLines('turn', 'Say hello.', '文件事件'));
    await shows('the record read after its file was created', [['Say hello.', '文件事件']]);
    // The timeline's own housekeeping interval aside, nothing here runs on a clock.
    expect(poll.mock.calls.filter(([, ms]) => ms !== 60_000)).toEqual([]);
  });

  it('shows the runtime turn at once and the record in its place, with every directory notification lost', async () => {
    directoryDelivery.enabled = false;
    const s = await setup();
    const { timeline, published, shows, onError } = await awaitingTimeline(s, 'codex-live-first');
    expect(timeline.getSnapshot().turns).toEqual([]);

    timeline.syncActiveTurn(live('S:turn:1', 'Reply in two parts.', 1));
    expect(texts(timeline.getSnapshot().turns)).toEqual([['Reply in two parts.']]);

    await s.create(meta + turnLines('turn', 'Reply in two parts.', 'First part.', 'Second part.'));
    // The runtime's turn grows: that is what looks for the record, not a file notification and not a clock.
    timeline.syncActiveTurn(live('S:turn:1', 'Reply in two parts.', 1, 'First part.'));
    timeline.syncActiveTurn(null);
    await shows('the record in place of the runtime turn', [['Reply in two parts.', 'First part.', 'Second part.']]);
    expect(timeline.getSnapshot().turns[0]).toMatchObject({ outcome: { kind: 'done' } });
    expect(timeline.getSnapshot().turns[0]!.id).not.toBe('S:turn:1');
    // Never no turn and never two: the runtime's turn stayed until the record held it.
    expect(published.length).toBeGreaterThan(0);
    expect(published.filter(state => state.length !== 1)).toEqual([]);
    expect(onError).not.toHaveBeenCalled();
  });

  it('keeps the ended runtime turn while its record is not written at all, and for as long', async () => {
    directoryDelivery.enabled = false;
    const s = await setup();
    const { timeline, published } = await awaitingTimeline(s, 'codex-end-first');
    timeline.syncActiveTurn(live('S:turn:1', 'Reply.', 1, 'Done.'));
    timeline.syncActiveTurn(null);
    // Read to now, and there is still no record: the turn the person saw stays.
    await timeline.catchUp();
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(texts(timeline.getSnapshot().turns)).toEqual([['Reply.', 'Done.']]);

    await s.create(meta + turnLines('turn', 'Reply.', 'Done.'));
    timeline.syncActiveTurn(live('S:turn:2', 'Next.', 2));
    await awaitFact('the first turn from its record', () => timeline.getSnapshot().turns[0]?.id !== 'S:turn:1' ? true : undefined);
    expect(texts(timeline.getSnapshot().turns)).toEqual([['Reply.', 'Done.'], ['Next.']]);
    expect(timeline.getSnapshot().turns[0]).toMatchObject({ outcome: { kind: 'done' } });
    expect(published.filter(state => state.length === 0)).toEqual([]);
  });

  it('keeps both of two turns opened by the same words', async () => {
    directoryDelivery.enabled = false;
    const s = await setup();
    const { timeline, shows } = await awaitingTimeline(s, 'codex-same-words');
    timeline.syncActiveTurn(live('S:turn:A', 'continue', 1));
    await s.create(meta + turnLines('a', 'continue', 'one'));
    timeline.syncActiveTurn(null);
    await shows('the first turn from its record', [['continue', 'one']]);
    timeline.syncActiveTurn(live('S:turn:B', 'continue', 2));
    expect(texts(timeline.getSnapshot().turns)).toEqual([['continue', 'one'], ['continue']]);
    await appendFile(s.file, turnLines('b', 'continue', 'two'));
    timeline.syncActiveTurn(null);
    await shows('both turns from the record', [['continue', 'one'], ['continue', 'two']]);
  });

  it('goes on awaiting a file whose first line is still being written', async () => {
    directoryDelivery.enabled = false;
    const s = await setup();
    await s.create(meta.slice(0, 20));
    const { timeline, shows, onError } = await awaitingTimeline(s, 'codex-partial-first-line');
    expect(timeline.getSnapshot().turns).toEqual([]);
    timeline.syncActiveTurn(live('S:turn:1', 'Say hello.', 1));
    await timeline.catchUp();
    await appendFile(s.file, meta.slice(20) + turnLines('turn', 'Say hello.', 'Hello.'));
    timeline.syncActiveTurn(null);
    await shows('the record read once its first line was whole', [['Say hello.', 'Hello.']]);
    expect(onError).not.toHaveBeenCalled();
  });

  it('fails a read that resumes a record which is gone', async () => {
    const s = await setup();
    const source = createCodexJsonlSource(s.locator);
    cleanups.push(() => source.stop());
    await expect(source.start({ onEntries: () => {}, onReset: () => {} }, { data: {}, fingerprint: 'codex:gone' }))
      .rejects.toBeInstanceOf(SessionRecordNotFoundError);
  });

  it('keeps both rollout appends in the timeline while Codex holds the file open', async () => {
    // macOS may defer directory events until an existing file's writer closes it. Keep the real file watcher
    // and hold back directory delivery so the case checks that precise condition on every OS.
    directoryDelivery.enabled = false;
    const s = await setup();
    await s.create();
    const writer = await open(s.file, 'a');
    cleanups.push(() => writer.close());

    const timeline = await createSessionTimeline(createCodexJsonlSource(s.locator), { sessionId: 'codex-held-open' });
    cleanups.push(() => timeline.dispose());
    const write = line;
    const messages = () => timeline.getSnapshot().turns.flatMap(turn => turn.items)
      .flatMap(item => item.kind === 'message' ? [item.text] : []);
    const waitForUpdate = (step: string, ready: () => boolean) => awaitPending(step, new Promise<void>(resolve => {
      const stop = timeline.subscribe(timeline.getSnapshot().cursor, () => {
        if (ready()) { stop(); resolve(); }
      });
      cleanups.push(stop);
    }));

    expect(messages()).toEqual([]);
    const first = waitForUpdate('first append delivered to the timeline with the writer open', () => messages().includes('First part.'));
    await writer.write(write('event_msg', { type: 'task_started', turn_id: 'turn' })
      + message('user', 'Reply in two parts.') + message('assistant', 'First part.'));
    await first;
    expect(messages()).toEqual(['Reply in two parts.', 'First part.']);

    const second = waitForUpdate('second append and completion delivered with the writer open',
      () => timeline.getSnapshot().turns.at(-1)?.outcome?.kind === 'done');
    await writer.write(message('assistant', 'Second part.') + write('event_msg', { type: 'task_complete', turn_id: 'turn' }));
    await second;
    expect(messages()).toEqual(['Reply in two parts.', 'First part.', 'Second part.']);

    // Returning to the view starts a new subscription without a cursor from this timeline.
    const returned = vi.fn();
    const stop = timeline.subscribe({ epoch: 'reopened-view', seq: 0 }, returned);
    cleanups.push(stop);
    expect(returned).toHaveBeenCalledWith(expect.objectContaining({
      snapshot: expect.objectContaining({
        turns: [expect.objectContaining({ items: expect.arrayContaining([
          expect.objectContaining({ role: 'user', text: 'Reply in two parts.' }),
          expect.objectContaining({ role: 'assistant', text: 'First part.' }),
          expect.objectContaining({ role: 'assistant', text: 'Second part.' }),
        ]), outcome: expect.objectContaining({ kind: 'done' }) })],
      }),
    }));
  });
});
