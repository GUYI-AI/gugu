import { describe, expect, it, vi } from 'vitest';
import { createWindowCommitJournal, type WindowLiveCursor, type WindowCommitReference, type WindowCommitPage } from './window-commit-journal';

const at = (sequence: number): WindowLiveCursor => ({ workerEpoch: 'worker', storeEpoch: 'store', sequence });
type Projected = Exclude<WindowCommitReference, { kind: 'needs_location' }>;
function item(n: number, revision = n): Projected {
  return { kind: n === revision ? 'insert' : 'update', referenceId: `ref-${n}`, rowId: `row-${n}`,
    storedSeq: n, projectionId: `projection-${n}-${revision}`, firstCommitCursor: at(n), latestRevisionCursor: at(revision) };
}
function fixture(limits?: Parameters<typeof createWindowCommitJournal>[0]['limits']) {
  const failed = vi.fn();
  const journal = createWindowCommitJournal({ epoch: at(0), onFailed: failed, limits });
  return { journal, failed, ready() { journal.seal(at(0)); journal.authorize(); } };
}

describe('a window owner’s durable commit reference journal', () => {
  it('registers before the authoritative cut and withholds new references until history is authorized', async () => {
    const { journal, failed } = fixture();
    journal.publish(item(1)); journal.publish(item(4)); journal.seal(at(3));
    const observed = vi.fn(), read = journal.read(at(3)).then(observed);
    await Promise.resolve(); expect(observed).not.toHaveBeenCalled();
    journal.authorize(); await read;
    expect(observed.mock.calls[0][0].entries.map((entry: WindowCommitReference) => entry.referenceId)).toEqual(['ref-4']);
    journal.publish(item(2)); // Old pre-cut persistence may finish late.
    expect(failed).not.toHaveBeenCalled();
  });

  it('delivers the last B arriving after A/hasMore=false but before A is ACKed without a hint or another commit', async () => {
    const { journal, ready } = fixture(); ready();
    const first = journal.read(at(0)); journal.publish(item(3));
    const a = await first; expect(a.hasMore).toBe(false);
    journal.publish(item(8)); journal.ack(a.next);
    let deliveredB: WindowCommitPage | undefined;
    const second = journal.read(a.next).then(page => { deliveredB = page; return page; });
    await Promise.resolve();
    expect(deliveredB?.entries.map(entry => entry.referenceId)).toEqual(['ref-8']);
    const b = await second;
    expect(b.entries.map(entry => entry.referenceId)).toEqual(['ref-8']);
    journal.ack(b.next);
    const waiting = journal.read(b.next), duplicate = journal.read(b.next);
    expect(waiting).toBe(duplicate);
    journal.publish(item(11));
    expect((await waiting).next).toEqual(at(11));
  });

  it('freezes an issued page while a revision appends separately, retaining the immutable first commit proof', async () => {
    const { journal, ready } = fixture(); ready();
    const source = item(3); journal.publish(source);
    const first = await journal.read(at(0));
    source.projectionId = 'mutated'; source.latestRevisionCursor.sequence = 999;
    journal.publish(item(3, 10));
    expect(await journal.read(at(0))).toBe(first);
    expect((first.entries[0] as Projected).projectionId).toBe('projection-3-3');
    expect(Object.isFrozen(first.entries[0].firstCommitCursor)).toBe(true);
    journal.ack(first.next);
    const revision = await journal.read(first.next);
    expect(revision.entries[0]).toMatchObject({ kind: 'update', firstCommitCursor: at(3), latestRevisionCursor: at(10) });
  });

  it('makes old ACKs idempotent after releasing data and rejects foreign epochs, partial pages and closed owners', async () => {
    const { journal, ready } = fixture(); ready();
    journal.publish(item(3)); journal.publish(item(8));
    const page = await journal.read(at(0));
    expect(() => journal.ack(at(3))).toThrow(/page end/);
    journal.ack(page.next); journal.ack(at(3)); journal.ack(page.next);
    expect(journal.inspect().queued).toBe(0);
    expect(() => journal.ack({ ...at(8), workerEpoch: 'another' })).toThrow(/epoch/);
    await expect(journal.read(at(0))).rejects.toMatchObject({ code: 'live_invalid_cursor' });
    journal.close(); expect(() => journal.ack(page.next)).toThrow(/released/);
  });

  it('settles the single empty read on release and never fails a cancelled owner or a different owner', async () => {
    const a = fixture(), b = fixture(); a.ready(); b.ready();
    const reading = a.journal.read(at(0));
    const rejected = expect(reading).rejects.toMatchObject({ code: 'unsubscribed' });
    a.journal.close(); await rejected;
    a.journal.publish(item(1)); expect(a.failed).not.toHaveBeenCalled();
    const other = b.journal.read(at(0)); b.journal.publish(item(1));
    expect((await other).entries).toHaveLength(1); expect(b.failed).not.toHaveBeenCalled();
    expect(a.journal.inspect()).toMatchObject({ waiting: false, queued: 0, bytes: 0, closed: true });
  });

  it('fails only the overflowing unacknowledged owner once and releases its queued references', async () => {
    const a = fixture({ entries: 1 }), b = fixture(); a.ready(); b.ready();
    a.journal.publish(item(1)); a.journal.publish(item(2)); a.journal.fail('io_failed', 'later error');
    expect(a.failed).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ code: 'live_buffer_overflow' }));
    expect(a.journal.inspect()).toMatchObject({ queued: 0, bytes: 0, closed: true });
    await expect(a.journal.read(at(0))).rejects.toMatchObject({ code: 'live_buffer_overflow' });
    b.journal.publish(item(3)); expect((await b.journal.read(at(0))).next).toEqual(at(3));
  });

  it('settles a waiting read on one fatal failure and does not raise its fixed capacity', async () => {
    const { journal, failed, ready } = fixture(); ready();
    const rejected = expect(journal.read(at(0))).rejects.toMatchObject({ code: 'io_failed' });
    journal.fail('io_failed', 'Projection source failed'); journal.fail('another', 'Late failure'); await rejected;
    expect(failed).toHaveBeenCalledTimes(1); expect(journal.inspect().waiting).toBe(false);
    expect(() => fixture({ entries: 65 })).toThrow(/cannot exceed/);
  });

  it('never serializes or retains an accidental turn payload and drains many ACKs within fixed reference storage', async () => {
    const { journal, ready } = fixture(); ready();
    let after = at(0);
    for (let n = 1; n <= 300; n++) {
      const input = Object.assign(item(n), { turn: { toJSON() { throw new Error('Whole turn was serialized'); } } });
      journal.publish(input);
      const page = await journal.read(after);
      expect(page.entries[0]).not.toHaveProperty('turn');
      journal.ack(page.next); after = page.next;
      expect(journal.inspect()).toMatchObject({ queued: 0, bytes: 0, waiting: false, delivered: false });
    }
  });

  it('bounds page bytes and treats a source regression as one terminal failure', async () => {
    const tiny = fixture({ pageEntries: 1 }); tiny.ready();
    tiny.journal.publish(item(1)); tiny.journal.publish(item(2));
    const page = await tiny.journal.read(at(0)); expect(page.hasMore).toBe(true); expect(page.entries).toHaveLength(1);
    tiny.journal.ack(page.next);
    const next = await tiny.journal.read(page.next); tiny.journal.ack(next.next);
    const waiting = tiny.journal.read(next.next), rejected = expect(waiting).rejects.toMatchObject({ code: 'live_sequence_regressed' });
    tiny.journal.publish(item(1)); await rejected;
    expect(tiny.failed).toHaveBeenCalledTimes(1);
    const bytes = fixture({ pageBytes: 10 }); bytes.ready(); bytes.journal.publish(item(1));
    expect(bytes.failed).toHaveBeenCalledWith(expect.objectContaining({ code: 'live_buffer_overflow' }));
  });

  it('carries a needs_location reference with only its scalar locator and keeps delivering later commits', async () => {
    const { journal, failed, ready } = fixture(); ready();
    const { projectionId: _projection, ...located } = item(2);
    journal.publish({ ...located, kind: 'needs_location', turn: 'never retained' } as unknown as WindowCommitReference); journal.publish(item(3));
    const page = await journal.read(at(0));
    expect(page.entries).toEqual([{ referenceId: 'ref-2', rowId: 'row-2', storedSeq: 2, kind: 'needs_location', firstCommitCursor: at(2), latestRevisionCursor: at(2) },
      expect.objectContaining({ kind: 'insert', referenceId: 'ref-3', projectionId: 'projection-3-3' })]);
    journal.ack(page.next); expect(failed).not.toHaveBeenCalled();
  });

  it('preserves an unproven historical first cursor as an update while still advancing its real revision ACK', async () => {
    const { journal, failed, ready } = fixture(); ready();
    journal.publish({ ...item(3, 10), kind: 'update', firstCommitCursor: null });
    const page = await journal.read(at(0));
    expect(page.entries[0]).toMatchObject({ kind: 'update', firstCommitCursor: null, latestRevisionCursor: at(10) });
    journal.ack(page.next); expect(journal.inspect().queued).toBe(0); expect(failed).not.toHaveBeenCalled();
  });
});
