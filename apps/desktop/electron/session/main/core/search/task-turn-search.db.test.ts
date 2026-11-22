import { openFixture } from '@tooling/utils/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TranscriptTurn } from '@gugu/session-core/acp';

const fixtureRef = vi.hoisted(() => ({
  current: undefined as Awaited<ReturnType<typeof openFixture>> | undefined,
}));

vi.mock('@main/db/client', () => ({
  get db() {
    return fixtureRef.current!.db;
  },
  get sqlite() {
    return fixtureRef.current!.sqlite;
  },
}));
vi.mock('@main/lib/events', () => ({ events: { emit: vi.fn() } }));
// The matcher runs on a thread of its own in the app (task-turn-search-worker.test.ts); here it reads the fixture.
vi.mock('./task-turn-search', () => ({ searchTaskTurnMatches: async (query: string, limit?: number, offset?: number) => matchTaskTurns(fixtureRef.current!.sqlite, query, limit, offset) }));

const { initializeDatabase } = await import('@main/db/initialize');
const { searchService } = await import('./search-service');
const { matchTaskTurns } = await import('./task-turn-matches');
const { textCondition } = await import('./text-condition');
const { searchController } = await import('./controller');
const { writeSessionIndex, updateSessionIndex } = await import('../session-index/session-index');
const { resolveConversationMessageReference } = await import('../../../../../../../packages/session-chat-ui/src/state/conversation-messages');
const { messageQuoteLink } = await import('@gugu/core/shared/ui/messageQuote');

function turn(id: string, items: TranscriptTurn['items'], seq = 0): TranscriptTurn {
  return { id, seq, initiator: 'user', items } as TranscriptTurn;
}
const said = (id: string, role: 'user' | 'assistant', text: string) => ({ kind: 'message', id, seq: 0, role, text }) as Extract<TranscriptTurn['items'][number], { kind: 'message' }>;

const fixture = () => fixtureRef.current!;
const indexed = () => fixture().sqlite.prepare('SELECT session_id, turn_id, role, text FROM turn_text_rows ORDER BY session_id, id').all();
const matches = (query: string) => matchTaskTurns(fixture().sqlite, query);
const found = (query: string) => matches(query).map((hit) => hit.excerpt);

describe('textCondition', () => {
  it('matches pieces of three or more characters on the trigram index and shorter ones by LIKE, all required', () => {
    expect(textCondition(' deploy  数据库 登录 ', 't', ['c', 'd'])).toEqual({
      sql: "t MATCH ? AND (c LIKE ? ESCAPE '\\' OR d LIKE ? ESCAPE '\\')",
      params: ['"deploy" AND "数据库"', '%登录%', '%登录%'],
    });
  });

  it('keeps a Chinese run whole: one substring, not words', () => {
    expect(textCondition('修复登录问题', 't', ['c'])).toEqual({ sql: 't MATCH ?', params: ['"修复登录问题"'] });
  });

  it('escapes LIKE wildcards and FTS quotes', () => {
    expect(textCondition('a_ 5%', 't', ['c'])!.params).toEqual(['%a\\_%', '%5\\%%']);
    expect(textCondition('say"hi"', 't', ['c'])!.params).toEqual(['"say""hi"""']);
  });

  it('has no condition for blank text', () => {
    expect(textCondition(' \n\t ', 't', ['c'])).toBeNull();
  });
});

describe('task content search (turn_text, written from each session timeline)', () => {
  beforeEach(async () => {
    fixtureRef.current = await openFixture('empty');
    fixture().sqlite.exec(`
      INSERT INTO projects (id, name, path) VALUES ('p1', 'P', '/repo');
      INSERT INTO projects (id, name, path, workspace_provider) VALUES ('p-ssh', 'R', '/srv', 'ssh');
      INSERT INTO sessions (id, project_id, config) VALUES
        ('s1', 'p1', '{"version":"1","type":"acp","agentDisplayName":"Task one"}'),
        ('s2', 'p1', '{"version":"1","type":"acp","agentDisplayName":"Task two"}'),
        ('s-ssh', 'p-ssh', '{"version":"1","type":"acp","agentDisplayName":"Remote"}');
    `);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fixtureRef.current?.close();
    fixtureRef.current = undefined;
  });

  it('searches what is indexed while the rest of the sessions are being read, and says so', async () => {
    writeSessionIndex('s1', [turn('t0', [said('u', 'user', 'available after indexing')])]);
    searchService.initialize();
    expect(searchController.commandPalette({ query: 'Task' }).length).toBeGreaterThan(0);
    expect(searchController.taskTurnIndexStatus().state).toBe('preparing');
    expect(await searchController.taskTurns({ query: 'indexing' })).toHaveLength(1);
    writeSessionIndex('s2', []);
    writeSessionIndex('s-ssh', []);
    expect(searchController.taskTurnIndexStatus().state).toBe('ready');
  });

  it('clears search by original message time', async () => {
    const at = Date.parse('2026-11-14T00:00:00Z');
    writeSessionIndex('s1', [turn('late-indexed', [
      { ...said('old', 'user', 'privacy searchable old'), at: at + 5000, _meta: { guguPublicationAt: new Date(at - 1000).toISOString() } },
      { ...said('new', 'assistant', 'privacy searchable new'), at: at + 1000 },
    ])]);
    vi.spyOn(await import('../sessions/native-publication-host'), 'nativeConversationHistoryFloor').mockResolvedValue('2026-11-14T00:00:00.000501Z');
    const hits = await searchService.searchTaskTurns('privacy searchable');
    expect(hits.map(hit => hit.excerpt)).toEqual(['privacy searchable new']);
    expect(found('privacy searchable')).toHaveLength(2);
  });

  it('continues beyond cleared matches to find another conversation', async () => {
    const at = Date.parse('2026-11-14T00:00:00Z');
    writeSessionIndex('s2', [turn('retained', [{ ...said('keep', 'user', 'sharedsearch retained'), at: at - 1000 }])]);
    writeSessionIndex('s1', Array.from({ length: 4 }, (_, index) => turn(`cleared-${index}`, [{ ...said(`old-${index}`, 'user', 'sharedsearch cleared'), at: at - 1000 }])));
    vi.spyOn(await import('../sessions/native-publication-host'), 'nativeConversationHistoryFloor').mockImplementation(async id => id === 's1' ? '2026-11-14T00:00:00Z' : null);
    const hits = await searchService.searchTaskTurns('sharedsearch', 2);
    expect(hits.map(hit => [hit.sessionId, hit.excerpt])).toEqual([['s2', 'sharedsearch retained']]);
  });

  it('indexes only what the person and the agent said', async () => {
    writeSessionIndex('s1', [turn('t0', [
      said('u', 'user', '请帮我修复登录页面的 crash'),
      { kind: 'thinking', id: 'th', seq: 1, text: 'secret plan about deployment' } as TranscriptTurn['items'][number],
      said('a', 'assistant', 'The deployment script is fixed.'),
    ])]);
    expect(indexed()).toEqual([
      { session_id: 's1', turn_id: 't0', role: 'user', text: '请帮我修复登录页面的 crash' },
      { session_id: 's1', turn_id: 't0', role: 'assistant', text: 'The deployment script is fixed.' },
    ]);
    expect(found('登录')).toEqual(['请帮我修复登录页面的 crash']);
    expect(found('deployment')).toEqual(['The deployment script is fixed.']);
    expect(found('secret')).toEqual([]);
    const [hit] = await searchService.searchTaskTurns('crash');
    expect(hit).toMatchObject({ sessionId: 's1', projectId: 'p1', title: 'Task one', role: 'user', archived: false, itemId: 'u' });
  });

  describe('a hit reveals the message it came from', () => {
    const reveal = (query: string, transcript: TranscriptTurn) => {
      const [hit] = matches(query);
      return resolveConversationMessageReference([transcript], messageQuoteLink({ kind: 'session', sessionId: 's1', itemId: hit!.itemId }), 's1');
    };

    it('a turn with a durable source is found under it, whichever copy of the turn is on screen', () => {
      const recorded = { ...turn('s1:node-7', [said('s1:node-7:message:0', 'user', 'found by its source')]), referenceId: 'source:real-turn' };
      writeSessionIndex('s1', [recorded]);
      expect(matches('found by')[0]!.itemId).toBe('source:real-turn:message:0');
      expect(reveal('found by', recorded)).toBe('s1:node-7:message:0');
      const runtime = { ...turn('runtime-3', [said('runtime-3:message:0', 'user', 'found by its source')]), referenceId: 'source:real-turn' };
      expect(reveal('found by', runtime)).toBe('runtime-3:message:0');
    });

    it('a numeric turn id has no durable source: searchable, never a guessed anchor', () => {
      const old = turn('s1:turn:5', [said('s1:turn:5:message:0', 'user', 'restarted counter')]);
      writeSessionIndex('s1', [old]);
      expect(matches('restarted')[0]!.itemId).toBe('s1:turn:5:message:0');
      expect(reveal('restarted', old)).toBeNull();
    });
  });

  it('retains activity source metadata and the original anchor without copying delivery text into that metadata', () => {
    const text = '<gugu_delivery route="chat" from="Worker" from_id="user:worker" from_type="agent"><![CDATA[private folded body]]></gugu_delivery>';
    writeSessionIndex('s1', [{ ...turn('t0', [said('t0:u', 'user', text)]), referenceId: 'source' }]);
    const [hit] = matches('folded');
    expect(hit!.activity).toMatchObject({ kind: 'received', facts: [{ fromType: 'agent', fromId: 'user:worker' }] });
    expect(JSON.stringify(hit!.activity)).not.toContain('private folded body');
    expect(hit!.itemId).toBe('source:u');
  });

  it('indexes what a delivery said, not its envelope, and never the silence marker', async () => {
    const { buildSystemNoticeEnvelope } = await import('@gugu/core/local/agent/deliveryEnvelope');
    const delivered = buildSystemNoticeEnvelope({ messageId: '0b1e7c1a-0000-4000-8000-000000000001', content: '主人把你改名为小橘', at: '2026-10-31T10:00:00Z' });
    writeSessionIndex('s1', [turn('t0', [said('u', 'user', delivered), said('a', 'assistant', '[NO_REPLY]')])]);
    expect(indexed()).toEqual([{ session_id: 's1', turn_id: 't0', role: 'user', text: '主人把你改名为小橘' }]);
    expect(found('小橘')).toEqual(['主人把你改名为小橘']);
    expect(found('gugu_delivery')).toEqual([]);
    expect(found('NO_REPLY')).toEqual([]);
  });

  it('follows a changed turn, a removed one and a session delete', () => {
    writeSessionIndex('s1', [turn('t0', [said('a', 'assistant', 'first draft answer')]), turn('t1', [said('r', 'assistant', 'from the native record')])]);
    updateSessionIndex('s1', [turn('t0', [said('a', 'assistant', 'final revised answer')])], []);
    expect(found('draft')).toEqual([]);
    expect(found('revised')).toEqual(['final revised answer']);
    updateSessionIndex('s1', [], ['t1']);
    expect(found('native')).toEqual([]);
    fixture().sqlite.exec("DELETE FROM sessions WHERE id = 's1'");
    expect(indexed()).toEqual([]);
    expect(found('revised')).toEqual([]);
  });

  it('keeps remote projects out and returns the newest first, by when the turn started', () => {
    writeSessionIndex('s1', [{ ...turn('t', [said('x', 'user', 'older alpha')]), startedAt: 1 }]);
    writeSessionIndex('s2', [{ ...turn('t', [said('y', 'assistant', 'newer alpha')]), startedAt: 2 }]);
    writeSessionIndex('s-ssh', [{ ...turn('t', [said('z', 'user', 'remote alpha')]), startedAt: 3 }]);
    expect(found('alpha')).toEqual(['newer alpha', 'older alpha']);
    expect(matches('alpha')[0]!.at).toBe(new Date(2).toISOString());
  });

  it('matches pieces shorter than a trigram, and only whole runs', () => {
    writeSessionIndex('s1', [turn('t', [said('x', 'user', '历史里的数据库迁移')])]);
    expect(found('数据库迁移')).toEqual(['历史里的数据库迁移']);
    expect(found('数据迁移')).toEqual([]);
    expect(found('迁移')).toEqual(['历史里的数据库迁移']);
  });
});

describe('search_index writes', () => {
  beforeEach(async () => {
    fixtureRef.current = await openFixture('empty');
    fixture().sqlite.exec("INSERT INTO projects (id, name, path) VALUES ('p1', 'alpha project', '/repo')");
    searchService.initialize();
  });

  afterEach(() => {
    fixtureRef.current?.close();
    fixtureRef.current = undefined;
  });

  it('keeps one row per item when it is written again', async () => {
    const { eq } = await import('drizzle-orm');
    const { sessions } = await import('@main/db/schema');
    const { sessionEvents } = await import('../sessions/session-events');
    const { mapSessionRowToSession } = await import('../sessions/utils');
    const { db, sqlite } = fixture();
    sqlite.exec(`INSERT INTO sessions (id, project_id, config) VALUES
      ('s1', 'p1', '{"version":"1","type":"acp","agentDisplayName":"alpha one"}'),
      ('s2', 'p1', '{"version":"1","type":"acp","agentDisplayName":"alpha two"}')`);
    for (const id of ['s1', 's2']) sessionEvents._emit('session:created', mapSessionRowToSession(db.select().from(sessions).where(eq(sessions.id, id)).get()!));
    sqlite.exec(`UPDATE sessions SET config = json_set(config, '$.agentDisplayName', 'alpha renamed') WHERE id = 's1'`);
    sessionEvents._emit('session:renamed', 's1', 'p1', 'alpha renamed');
    await vi.waitFor(() => expect(sqlite.prepare("SELECT title FROM search_index WHERE item_id = 's1'").all()).toEqual([{ title: 'alpha renamed' }]));
    expect(sqlite.prepare("SELECT title FROM search_index WHERE item_id = 'p1'").all()).toEqual([{ title: 'alpha project' }]);
  });
  it('an index built as version 6 (said-in-tasks search) is rebuilt once and names each task by its one name', async () => {
    const { sqlite } = fixture();
    const currentVersion = sqlite.prepare("SELECT value FROM kv WHERE key = 'fts_version'").get();
    sqlite.exec(`INSERT INTO sessions (id, project_id, title, config) VALUES
      ('s1', 'p1', 'old shown title', '{"version":"1","type":"acp","agentDisplayName":"Task one"}')`);
    sqlite.exec(`DELETE FROM search_index;
      INSERT INTO search_index (item_type, item_id, project_id, title, keywords) VALUES ('session', 's1', 'p1', 'old shown title', '');
      UPDATE kv SET value = '6' WHERE key = 'fts_version'`);
    await initializeDatabase(sqlite);
    expect(sqlite.prepare("SELECT value FROM kv WHERE key = 'fts_version'").get()).toEqual(currentVersion);
    expect(sqlite.prepare('SELECT count(*) AS n FROM search_index').get()).toEqual({ n: 0 });
    searchService.initialize(); // boot backfills the rebuilt index
    expect(sqlite.prepare("SELECT title FROM search_index WHERE item_id = 's1'").all()).toEqual([{ title: 'Task one' }]);
  });
});
