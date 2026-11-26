import { describe, expect, it } from 'vitest';
import type { ArchivedSessionRef, PermanentDeleteOutcome } from '@shared/core/sessions/sessions';
import {
  PERMANENT_DELETE_BATCH_MAX,
  PERMANENT_DELETE_UNDO_MS,
  PermanentDeleteRun,
  UndoCountdown,
  planDeleteBatches,
  settleDeleteBatch,
  type Clock,
  type DeleteOnMachine,
  type PermanentDeleteSnapshot,
  type PermanentDeleteTarget,
} from './permanent-delete-flow';

function fakeClock() {
  let now = 0;
  let seq = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const clock: Clock = {
    now: () => now,
    setTimeout: (callback, ms) => {
      const id = ++seq;
      timers.set(id, { at: now + ms, callback });
      return id;
    },
    clearTimeout: (handle) => void timers.delete(handle as number),
  };
  const advance = (ms: number) => {
    const until = now + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      now = due[1].at;
      due[1].callback();
    }
    now = until;
  };
  return { clock, advance, pending: () => timers.size };
}

const target = (index: number, machine: string | null = null): PermanentDeleteTarget => ({
  key: `row-${machine ?? 'local'}-${index}`,
  machine,
  projectId: `p-${machine ?? 'local'}`,
  sessionId: `s-${index}`,
});
const targets = (count: number, machine: string | null = null) => Array.from({ length: count }, (_, i) => target(i, machine));
const ref = ({ projectId, sessionId }: ArchivedSessionRef): ArchivedSessionRef => ({ projectId, sessionId });

/** 一台假机器:默认全删掉;calls 记下每次问了谁、带没带子会话。 */
function fakeMachines(decide?: (machine: string | null, asked: ArchivedSessionRef[]) => PermanentDeleteOutcome | Promise<PermanentDeleteOutcome>) {
  const calls: Array<{ machine: string | null; asked: ArchivedSessionRef[]; withChildren: boolean }> = [];
  const deleteOn: DeleteOnMachine = async (machine, asked, { withChildren }) => {
    calls.push({ machine, asked, withChildren });
    return decide ? decide(machine, asked) : { deleted: asked, failed: [], unreached: [] };
  };
  return { calls, deleteOn };
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('planDeleteBatches', () => {
  it('groups per machine in first-seen order and never sends more than 50 at once', () => {
    const mixed = [...targets(120, 'mac-a').slice(0, 60), target(0, null), ...targets(120, 'mac-a').slice(60), ...targets(3, 'mac-b')];
    const batches = planDeleteBatches(mixed);
    expect(batches.map((batch) => [batch.machine, batch.targets.length])).toEqual([
      ['mac-a', 50],
      ['mac-a', 50],
      ['mac-a', 20],
      [null, 1],
      ['mac-b', 3],
    ]);
    expect(batches.flatMap((batch) => batch.targets.map((t) => t.key)).filter((key) => key.startsWith('row-mac-a'))).toEqual(
      targets(120, 'mac-a').map((t) => t.key)
    );
  });

  it('refuses a batch size the main process would reject', () => {
    expect(() => planDeleteBatches(targets(1), PERMANENT_DELETE_BATCH_MAX + 1)).toThrow();
    expect(() => planDeleteBatches(targets(1), 0)).toThrow();
  });
});

describe('settleDeleteBatch', () => {
  it('maps the receipt back to rows; a row the receipt does not mention counts as failed, never as deleted', () => {
    const asked = targets(3);
    const child = { projectId: 'p-local', sessionId: 'child-of-0' };
    const result = settleDeleteBatch(null, asked, {
      deleted: [child, ref(asked[0])],
      failed: [{ ...ref(asked[1]), reason: 'not_archived' }],
      unreached: [],
    });
    expect(result.deletedKeys).toEqual([asked[0].key]);
    expect(result.alsoDeleted).toEqual([child]);
    expect(result.failed.map((f) => [f.key, f.reason])).toEqual([
      [asked[1].key, 'not_archived'],
      [asked[2].key, 'no_receipt'],
    ]);
  });
});

describe('UndoCountdown', () => {
  it('pauses per reason and resumes only when every reason is gone, keeping the remaining time', () => {
    const { clock, advance } = fakeClock();
    let expired = 0;
    const countdown = new UndoCountdown(8000, () => expired++, clock);
    countdown.start();
    advance(3000);
    countdown.pause('hover');
    countdown.pause('blur');
    advance(60_000);
    expect(expired).toBe(0);
    expect(countdown.remainingMs).toBe(5000);
    countdown.resume('hover');
    advance(60_000);
    expect(expired).toBe(0); // still blurred
    countdown.resume('blur');
    advance(4999);
    expect(expired).toBe(0);
    advance(1);
    expect(expired).toBe(1);
  });
});

describe('PermanentDeleteRun', () => {
  it('undo inside the window deletes nothing', async () => {
    const { clock, advance } = fakeClock();
    const { calls, deleteOn } = fakeMachines();
    const run = new PermanentDeleteRun({ targets: targets(3), withChildren: false, deleteOn, clock });
    run.start();
    advance(PERMANENT_DELETE_UNDO_MS - 1);
    expect(run.undo()).toBe(true);
    advance(60_000);
    await flush();
    expect(calls).toEqual([]);
    expect((await run.finished).phase).toBe('undone');
  });

  it('deletes only after the window, in batches of ≤50 per machine, one report per batch', async () => {
    const { clock, advance } = fakeClock();
    const { calls, deleteOn } = fakeMachines();
    const reports: number[] = [];
    const progress: Array<[number, number]> = [];
    const run = new PermanentDeleteRun({
      targets: [...targets(120, 'mac-a'), ...targets(30, null)],
      withChildren: true,
      deleteOn,
      clock,
      onBatch: (result) => reports.push(result.deletedKeys.length),
      onChange: (snapshot) => {
        if (snapshot.phase === 'deleting') progress.push([snapshot.processed, snapshot.total]);
      },
    });
    run.start();
    advance(PERMANENT_DELETE_UNDO_MS - 1);
    await flush();
    expect(calls).toEqual([]);
    advance(1);
    const end = await run.finished;
    expect(calls.map((call) => [call.machine, call.asked.length, call.withChildren])).toEqual([
      ['mac-a', 50, true],
      ['mac-a', 50, true],
      ['mac-a', 20, true],
      [null, 30, true],
    ]);
    expect(reports).toEqual([50, 50, 20, 30]);
    expect(progress).toEqual([
      [0, 150],
      [50, 150],
      [100, 150],
      [120, 150],
      [150, 150],
    ]);
    expect(end).toMatchObject({ phase: 'done', processed: 150, deletedCount: 150, failed: [], notAttempted: [] });
    expect(run.undo()).toBe(false);
  });

  it('pausing the notice holds the deletion back', async () => {
    const { clock, advance } = fakeClock();
    const { calls, deleteOn } = fakeMachines();
    const run = new PermanentDeleteRun({ targets: targets(2), withChildren: false, deleteOn, clock });
    run.start();
    advance(7000);
    run.pauseUndo('hover');
    expect(run.snapshot()).toMatchObject({ undoRemainingMs: 1000, undoPaused: true });
    advance(30_000);
    await flush();
    expect(calls).toEqual([]);
    run.resumeUndo('hover');
    advance(1000);
    await run.finished;
    expect(calls).toHaveLength(1);
  });

  it('stop finishes the batch in flight; deleted stay deleted, the rest come back untouched', async () => {
    let release!: () => void;
    const { calls, deleteOn } = fakeMachines(async (_machine, asked) => {
      if (calls.length === 1) await new Promise<void>((resolve) => (release = resolve));
      return { deleted: asked, failed: [], unreached: [] };
    });
    const all = targets(300, 'mac-a');
    const run = new PermanentDeleteRun({ targets: all, withChildren: false, deleteOn, undoMs: 0 });
    run.start();
    await flush();
    expect(calls).toHaveLength(1);
    run.stop();
    expect(run.snapshot().phase).toBe('stopping');
    release();
    const end = await run.finished;
    expect(calls).toHaveLength(1);
    expect(end).toMatchObject({ phase: 'done', processed: 50, deletedCount: 50 });
    expect(end.notAttempted.map((t) => t.key)).toEqual(all.slice(50).map((t) => t.key));
  });

  it('a failed batch call fails only its rows; partial failures carry reasons; retry re-runs only those', async () => {
    const { calls, deleteOn } = fakeMachines((machine, asked) => {
      if (machine === 'mac-down') throw new Error('machine offline');
      return { deleted: asked.slice(1), failed: [{ ...asked[0], reason: 'not_archived' }], unreached: [] };
    });
    const run = new PermanentDeleteRun({
      targets: [...targets(4, 'mac-a'), ...targets(2, 'mac-down'), ...targets(3, null)],
      withChildren: false,
      deleteOn,
      undoMs: 0,
    });
    run.start();
    const end = await run.finished;
    expect(calls.map((call) => call.machine)).toEqual(['mac-a', 'mac-down', null]);
    expect(end.deletedCount).toBe(5);
    expect(end.failed.map((f) => [f.key, f.reason])).toEqual([
      ['row-mac-a-0', 'not_archived'],
      ['row-mac-down-0', 'machine offline'],
      ['row-mac-down-1', 'machine offline'],
      ['row-local-0', 'not_archived'],
    ]);

    const retryTargets = run.retryTargets();
    expect(retryTargets.map((t) => t.key)).toEqual(['row-mac-a-0', 'row-mac-down-0', 'row-mac-down-1', 'row-local-0']);
    expect(retryTargets.every((t) => !('reason' in t))).toBe(true);
    const retried = fakeMachines();
    const retry = new PermanentDeleteRun({ targets: retryTargets, withChildren: false, deleteOn: retried.deleteOn, undoMs: 0 });
    retry.start();
    expect((await retry.finished).deletedCount).toBe(4);
    expect(retried.calls.map((call) => [call.machine, call.asked.map((a) => a.sessionId)])).toEqual([
      ['mac-a', ['s-0']],
      ['mac-down', ['s-0', 's-1']],
      [null, ['s-0']],
    ]);
  });

  it('collects machines the children could not reach once each', async () => {
    const away = { deviceId: 'mac-z', label: 'Studio', detail: 'offline' };
    const { deleteOn } = fakeMachines((_machine, asked) => ({ deleted: asked, failed: [], unreached: [away] }));
    const run = new PermanentDeleteRun({ targets: targets(120), withChildren: true, deleteOn, undoMs: 0 });
    run.start();
    expect((await run.finished).unreached).toEqual([away]);
  });

  it('a row already removed as a child in an earlier batch is not asked for again', async () => {
    const all = targets(51);
    const lateChild = all[50];
    const { calls, deleteOn } = fakeMachines((_machine, asked) => ({
      deleted: calls.length === 1 ? [...asked, ref(lateChild)] : asked,
      failed: [],
      unreached: [],
    }));
    const batches: string[][] = [];
    const run = new PermanentDeleteRun({ targets: all, withChildren: true, deleteOn, undoMs: 0, onBatch: (r) => batches.push(r.deletedKeys) });
    run.start();
    const end = await run.finished;
    expect(calls).toHaveLength(1);
    expect(batches[1]).toEqual([lateChild.key]);
    expect(end).toMatchObject({ deletedCount: 51, failed: [] });
  });

  it('commitNow skips the rest of the window (a newer delete takes over the undo)', async () => {
    const { clock, advance, pending } = fakeClock();
    const { calls, deleteOn } = fakeMachines();
    const seen: PermanentDeleteSnapshot['phase'][] = [];
    const run = new PermanentDeleteRun({ targets: targets(1), withChildren: false, deleteOn, clock, onChange: (s) => seen.push(s.phase) });
    run.start();
    advance(1000);
    run.commitNow();
    expect(pending()).toBe(0);
    await run.finished;
    expect(calls).toHaveLength(1);
    expect(run.undo()).toBe(false);
    expect(seen[0]).toBe('undo');
    expect(seen.at(-1)).toBe('done');
  });

  it('rejects an empty or duplicated selection up front', () => {
    const { deleteOn } = fakeMachines();
    expect(() => new PermanentDeleteRun({ targets: [], withChildren: false, deleteOn })).toThrow();
    expect(() => new PermanentDeleteRun({ targets: [target(1), target(1)], withChildren: false, deleteOn })).toThrow();
  });
});
