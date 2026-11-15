import { openFixture } from '@tooling/utils/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDb } from '@main/db/client';
import type { TranscriptTurn } from '@gugu/session-core/acp';
import { LOCAL_PAYLOAD_BUDGET, REMOTE_OLDER_PAGE_BUDGET, TRANSPORT_PAYLOAD_BUDGET } from '@gugu/session-core/session-record';

// One older page is cut to a byte budget before it leaves the main process. Two things are held here:
//  ① a window on this machine gets a much larger page than a device link does, over the same paging;
//  ② the read stops once the page is full. It used to read `limit` rows, keep the few that fit, and read the same
//     rows again for the next page.

const mocks = vi.hoisted(() => ({ db: undefined as AppDb | undefined }));

vi.mock('@main/db/client', () => ({
  get db() {
    if (!mocks.db) throw new Error('Test database not initialized');
    return mocks.db;
  },
}));
vi.mock('@main/lib/events', () => ({ events: { emit: vi.fn() } }));

import { getStoredHistory, persistCommittedTurn } from './session-turn-store';

type Fixture = Awaited<ReturnType<typeof openFixture>>;

const TURN_BYTES = 10_000;
/** A turn's text plus its ids, times and outcome: what one turn of this fixture weighs in a page. */
const turnWeight = (bytes = TURN_BYTES) => new TextEncoder().encode(JSON.stringify(turn(0, bytes))).byteLength + 1;
function turn(index: number, bytes = TURN_BYTES): TranscriptTurn {
  return {
    id: `c1:turn:${index}`, seq: index, initiator: 'user', startedAt: 1_000 + index, endedAt: 2_000 + index, outcome: { kind: 'done' },
    items: [{ kind: 'message', id: `c1:turn:${index}:m`, seq: 0, role: 'assistant', text: 'x'.repeat(bytes) }],
  } as TranscriptTurn;
}

describe('stored history page budget', () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await openFixture('empty');
    mocks.db = fixture.db;
    fixture.sqlite.exec(`
      INSERT INTO projects (id, name, path) VALUES ('p1', 'P', '/repo');
      INSERT INTO sessions (id, project_id) VALUES ('c1', 'p1');
    `);
  });

  afterEach(() => { fixture.close(); vi.restoreAllMocks(); });

  const store = async (count: number, bytes = TURN_BYTES) => {
    for (let i = 0; i < count; i += 1) await persistCommittedTurn({ sessionId: 'c1', source: 'live', turn: turn(i, bytes) });
  };
  const walk = async (reader: { local?: boolean }) => {
    const pages: number[][] = [];
    let before: number | undefined;
    for (;;) {
      const page = await getStoredHistory({ sessionId: 'c1', before, limit: 100 }, reader);
      pages.push(page.turns.map(item => item.seq));
      expect(page.originTurnIds).toHaveLength(page.turns.length);
      if (page.nextCursor === null) return pages;
      before = page.nextCursor;
    }
  };

  it('pages a device link at the transport budget, every turn once and in order', async () => {
    await store(160);
    const pages = await walk({});
    // The first screen opens the conversation and stays small; a page asked for by going back is larger.
    expect(pages[0]).toHaveLength(Math.floor(TRANSPORT_PAYLOAD_BUDGET / turnWeight()));
    expect(pages[0]!.at(-1)).toBe(159);
    expect(pages[1]).toHaveLength(Math.floor(REMOTE_OLDER_PAGE_BUDGET / turnWeight()));
    expect(pages[2]).toHaveLength(Math.floor(REMOTE_OLDER_PAGE_BUDGET / turnWeight()));
    expect(pages.toReversed().flat()).toEqual(Array.from({ length: 160 }, (_, i) => i));
  });

  it('keeps a first read that names a place (a phone opening at its unread line) at the first-screen size', async () => {
    await store(160);
    const page = await getStoredHistory({ sessionId: 'c1', before: 120, limit: 100 }, { older: false });
    expect(page.turns).toHaveLength(Math.floor(TRANSPORT_PAYLOAD_BUDGET / turnWeight()));
    expect(page.turns.at(-1)!.seq).toBe(119);
  });

  it('sends only the opening of tool output to a device-link reader whose view does not show it, and to no one else', async () => {
    const output = 'o'.repeat(6_000);
    for (let i = 0; i < 3; i += 1) {
      await persistCommittedTurn({ sessionId: 'c1', source: 'live', turn: { ...turn(i, 10),
        items: [{ kind: 'execute-tool-call', id: `c1:turn:${i}:e`, seq: 0, toolCallId: `e${i}`, title: 'run', status: 'done', outputText: output }] } as TranscriptTurn });
    }
    const outputs = (page: { turns: TranscriptTurn[] }) => page.turns.map(one => (one.items[0] as { outputText?: string }).outputText!.length);
    const lean = await getStoredHistory({ sessionId: 'c1', limit: 100, lean: true });
    expect(lean.turns.map(one => one.seq)).toEqual([0, 1, 2]);
    expect(Math.max(...outputs(lean))).toBeLessThan(output.length / 10);
    // A reader that did not ask (an older build, a view that shows output) gets it as before.
    expect(outputs(await getStoredHistory({ sessionId: 'c1', limit: 100 }))).toEqual([6_000, 6_000, 6_000]);
    // A window on this machine reads its own database: it is never sent less, whatever it asks.
    expect(outputs(await getStoredHistory({ sessionId: 'c1', limit: 100, lean: true }, { local: true }))).toEqual([6_000, 6_000, 6_000]);
  });

  it('carries a call\'s step line and not its raw input only to a device-link reader that asked for lean pages', async () => {
    await persistCommittedTurn({ sessionId: 'c1', source: 'live', turn: { ...turn(0, 10),
      items: [{ kind: 'mcp-tool-call', id: 'c1:turn:0:m', seq: 0, toolCallId: 'm', server: 'github', tool: 'search', title: 'search', status: 'done', rawInput: '{"query":"needle"}' }] } as TranscriptTurn });
    const call = async (params: { lean?: boolean; fromSeq?: number }, reader?: { local: boolean }) =>
      (await getStoredHistory({ sessionId: 'c1', ...(params.fromSeq === undefined ? { limit: 100 } : {}), ...params }, reader)).turns[0]!.items[0] as { rawInput?: string; inputSummary?: string };
    expect(await call({ lean: true })).toMatchObject({ inputSummary: 'needle' });
    expect(await call({ lean: true })).not.toHaveProperty('rawInput');
    // Whole: a reader that did not ask, a window on this machine, and the read that catches a window up.
    for (const whole of [await call({}), await call({ lean: true }, { local: true }), await call({ lean: true, fromSeq: 0 })]) {
      expect(whole.rawInput).toBe('{"query":"needle"}');
      expect(whole).not.toHaveProperty('inputSummary');
    }
  });

  it('carries a turn as its folded form only on a page a device-link reader went back for, and whole when read again', async () => {
    for (let i = 0; i < 3; i += 1) {
      await persistCommittedTurn({ sessionId: 'c1', source: 'live', turn: { ...turn(i, 10),
        items: [{ kind: 'execute-tool-call', id: `c1:turn:${i}:e`, seq: 0, toolCallId: `e${i}`, title: 'run', status: 'done', command: 'make' }] } as TranscriptTurn });
    }
    const held = (page: { turns: TranscriptTurn[] }) => page.turns.map(one => (one.items[0] as { held?: true; command?: string }).held === true);
    // Gone back for: folded.
    expect(held(await getStoredHistory({ sessionId: 'c1', before: 3, limit: 100, lean: 'folded' }))).toEqual([true, true, true]);
    // The newest page is read again whenever the conversation moves: it stays as a lean page.
    expect(held(await getStoredHistory({ sessionId: 'c1', limit: 100, lean: 'folded' }))).toEqual([false, false, false]);
    // The read that puts one turn back, and a window on this machine: whole.
    const again = await getStoredHistory({ sessionId: 'c1', before: 2, limit: 1, lean: true });
    expect(again.turns.map(one => [one.seq, (one.items[0] as { command?: string }).command, (one.items[0] as { held?: true }).held])).toEqual([[1, 'make', undefined]]);
    expect(held(await getStoredHistory({ sessionId: 'c1', before: 3, limit: 100, lean: 'folded' }, { local: true }))).toEqual([false, false, false]);
  });

  it('gives a window on this machine the larger page', async () => {
    await store(60);
    expect(60 * TURN_BYTES).toBeLessThan(LOCAL_PAYLOAD_BUDGET);
    const pages = await walk({ local: true });
    expect(pages).toEqual([Array.from({ length: 60 }, (_, i) => i)]);
  });

  it('cuts the local page at its own budget too', async () => {
    await store(30, 100_000);
    const pages = await walk({ local: true });
    expect(pages[0]).toHaveLength(Math.floor(LOCAL_PAYLOAD_BUDGET / turnWeight(100_000)));
    expect(pages.toReversed().flat()).toEqual(Array.from({ length: 30 }, (_, i) => i));
  });

  it('stops reading once the page is full', async () => {
    await store(60);
    const parse = vi.spyOn(JSON, 'parse');
    const page = await getStoredHistory({ sessionId: 'c1', limit: 100 });
    const rowsParsed = parse.mock.calls.filter(([text]) => typeof text === 'string' && text.length >= TURN_BYTES).length;
    // The page holds what fits; the read overshoots it by less than two steps, not by the rest of the hundred.
    expect(page.turns.length).toBe(Math.floor(TRANSPORT_PAYLOAD_BUDGET / turnWeight()));
    expect(rowsParsed).toBeLessThan(page.turns.length + 16);
    expect(rowsParsed).toBeLessThan(60);
  });

  it('still sends a turn that is larger than the whole budget', async () => {
    await store(3, 600_000);
    expect(600_000).toBeGreaterThan(REMOTE_OLDER_PAGE_BUDGET);
    const pages = await walk({});
    expect(pages).toEqual([[2], [1], [0]]);
  });

  it('reports the start of the history without an empty page after it', async () => {
    await store(8, 100);
    const page = await getStoredHistory({ sessionId: 'c1', limit: 100 });
    expect(page.turns).toHaveLength(8);
    expect(page.nextCursor).toBeNull();
  });
});
