import { describe, expect, it, vi } from 'vitest';
import { startAcpWindowCommitReader, type AcpWindowCommitReaderPort } from './acp-window-commit-reader';

type Page = { end: number; text: string; hasMore: boolean };
const page = (end: number): Page => ({ end, text: `reply-${end}`, hasMore: false });
async function flush() { for (let n = 0; n < 8; n++) await Promise.resolve(); }
function fixture() {
  let waiting: ReturnType<typeof Promise.withResolvers<Page>>;
  const rows = ['opening history'];
  const events: string[] = [];
  const port = {
    read: vi.fn((after: number) => {
      events.push(`read:${after}`);
      waiting = Promise.withResolvers<Page>();
      return waiting.promise;
    }),
    cursor: (value: Page) => value.end,
    materialize: vi.fn(async (value: Page) => { events.push('materialize'); return value.text; }),
    commit: vi.fn((text: string) => { rows.push(text); events.push('commit'); }),
    ack: vi.fn(async (through: number) => { events.push(`ack:${through}`); }),
    release: vi.fn(() => { waiting.reject(new Error('Owner released')); }),
    failed: vi.fn(),
  } satisfies AcpWindowCommitReaderPort<number, Page, string>;
  return { port, rows, events, deliver(value: Page) { waiting.resolve(value); },
    reject(error: Error) { waiting.reject(error); } };
}

describe('a window owner reading and acknowledging durable commit pages', () => {
  it('materializes and atomically commits before ACK, then reads after hasMore=false without another hint', async () => {
    const f = fixture(), projection = Promise.withResolvers<string>();
    f.port.materialize.mockImplementationOnce(() => projection.promise);
    const reader = startAcpWindowCommitReader(0, f.port);
    f.deliver(page(3)); await flush();
    expect(f.port.read).toHaveBeenCalledTimes(1);
    expect(f.port.ack).not.toHaveBeenCalled();
    expect(f.rows).toEqual(['opening history']);
    projection.resolve('reply-3'); await flush();
    expect(f.events).toEqual(['read:0', 'commit', 'ack:3', 'read:3']);
    expect(f.rows).toEqual(['opening history', 'reply-3']);
    f.deliver(page(8)); await flush();
    expect(f.rows).toEqual(['opening history', 'reply-3', 'reply-8']);
    expect(f.port.read.mock.calls.map(([after]) => after)).toEqual([0, 3, 8]);
    reader.close(); await reader.completed;
  });

  it('releases one empty waiting read exactly once without reporting cancellation as failure', async () => {
    const f = fixture(), reader = startAcpWindowCommitReader(0, f.port);
    reader.close(); reader.close(); await reader.completed;
    expect(f.port.release).toHaveBeenCalledTimes(1);
    expect(f.port.materialize).not.toHaveBeenCalled();
    expect(f.port.commit).not.toHaveBeenCalled();
    expect(f.port.failed).not.toHaveBeenCalled();
  });

  it('discards a page returned synchronously by release instead of committing it to a closed view', async () => {
    const f = fixture();
    f.port.release.mockImplementation(() => f.deliver(page(3)));
    const reader = startAcpWindowCommitReader(0, f.port);
    reader.close(); await reader.completed;
    expect(f.port.materialize).not.toHaveBeenCalled();
    expect(f.rows).toEqual(['opening history']);
    expect(f.port.ack).not.toHaveBeenCalled();
  });

  it('does not publish a projection that finishes after the owner closes', async () => {
    const f = fixture(), projection = Promise.withResolvers<string>();
    f.port.materialize.mockImplementationOnce(() => projection.promise);
    const reader = startAcpWindowCommitReader(0, f.port);
    f.deliver(page(3)); await flush(); reader.close();
    projection.resolve('obsolete reply'); await reader.completed;
    expect(f.rows).toEqual(['opening history']);
    expect(f.port.ack).not.toHaveBeenCalled();
    expect(f.port.failed).not.toHaveBeenCalled();
  });

  it('does not ACK when resident publication synchronously replaces the owner', async () => {
    const f = fixture(), reader = startAcpWindowCommitReader(0, f.port);
    f.port.commit.mockImplementationOnce(() => reader.close());
    f.deliver(page(3)); await reader.completed;
    expect(f.port.ack).not.toHaveBeenCalled();
    expect(f.port.release).toHaveBeenCalledTimes(1);
    expect(f.port.failed).not.toHaveBeenCalled();
  });

  it('ignores a late ACK rejection after closing and never opens a second read', async () => {
    const f = fixture(), ack = Promise.withResolvers<void>();
    f.port.ack.mockImplementationOnce(() => ack.promise);
    const reader = startAcpWindowCommitReader(0, f.port);
    f.deliver(page(3)); await flush(); reader.close();
    ack.reject(new Error('Old subscription')); await reader.completed;
    expect(f.port.read).toHaveBeenCalledTimes(1);
    expect(f.port.failed).not.toHaveBeenCalled();
  });

  it.each(['read', 'materialize', 'commit', 'ack'] as const)(
    'makes a %s error terminal without retrying and retains the already displayed history', async stage => {
      const f = fixture(), error = new Error(`${stage} failed`);
      if (stage === 'materialize') f.port.materialize.mockRejectedValueOnce(error);
      if (stage === 'commit') f.port.commit.mockImplementationOnce(() => { throw error; });
      if (stage === 'ack') f.port.ack.mockRejectedValueOnce(error);
      const reader = startAcpWindowCommitReader(0, f.port);
      if (stage === 'read') f.reject(error); else f.deliver(page(3));
      await reader.completed;
      expect(f.port.failed).toHaveBeenCalledExactlyOnceWith(error);
      expect(f.port.release).toHaveBeenCalledTimes(1);
      expect(f.port.read).toHaveBeenCalledTimes(1);
      expect(f.rows).toEqual(stage === 'ack' ? ['opening history', 'reply-3'] : ['opening history']);
      if (stage !== 'ack') expect(f.port.ack).not.toHaveBeenCalled();
      reader.close(); expect(f.port.release).toHaveBeenCalledTimes(1);
    },
  );

  it('keeps a replacement owner independent of the old materialization and failure', async () => {
    const a = fixture(), oldProjection = Promise.withResolvers<string>();
    a.port.materialize.mockImplementationOnce(() => oldProjection.promise);
    const old = startAcpWindowCommitReader(0, a.port);
    a.deliver(page(3)); await flush(); old.close();
    const b = fixture(), current = startAcpWindowCommitReader(8, b.port);
    b.deliver(page(10)); await flush();
    oldProjection.reject(new Error('Old disk read')); await old.completed;
    expect(a.rows).toEqual(['opening history']);
    expect(a.port.failed).not.toHaveBeenCalled();
    expect(b.rows).toEqual(['opening history', 'reply-10']);
    expect(b.port.failed).not.toHaveBeenCalled();
    current.close(); await current.completed;
  });
});
