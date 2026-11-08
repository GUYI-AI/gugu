import { openFixture } from '@tooling/utils/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDb } from '@main/db/client';

const mocks = vi.hoisted(() => ({ db: undefined as AppDb | undefined }));
vi.mock('@main/db/client', () => ({
  get db() {
    if (!mocks.db) throw new Error('Test database not initialized');
    return mocks.db;
  },
}));
vi.mock('@main/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { priorConversationBlock } from './prior-conversation';

describe('priorConversationBlock', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;
  const seed = (config: Record<string, unknown>) => {
    fixture.sqlite.prepare("INSERT INTO sessions (id, project_id, workspace_id, title, runtime, config) VALUES ('s', 'p', 'root', 'T', 'acp', ?)")
      .run(JSON.stringify({ version: '1', type: 'acp', ...config }));
  };
  const turn = (seq: number, items: unknown[]) => {
    fixture.sqlite.prepare('INSERT INTO session_turns (id, session_id, seq, turn_id, data) VALUES (?, ?, ?, ?, ?)')
      .run(`s:${seq}`, 's', seq, `run:turn:${seq}`, JSON.stringify({ id: `s:turn:s${seq}`, seq, status: 'done', reason: 'end_turn', initiator: 'user', items }));
  };
  const message = (role: string, text: string) => ({ kind: 'message', id: `${role}-${text.length}`, seq: 0, role, text });

  beforeEach(async () => {
    fixture = await openFixture('empty');
    mocks.db = fixture.db;
    fixture.sqlite.exec(`
      INSERT INTO workspaces (id, type, kind, location, path, key) VALUES ('root', 'local', 'project-root', 'local', '/repo', 'root');
      INSERT INTO projects (id, name, path, repository_workspace_id) VALUES ('p', 'P', '/repo', 'root');
    `);
  });
  afterEach(() => { fixture.close(); mocks.db = undefined; });

  it('is nothing for a session whose engine session was never replaced', async () => {
    seed({});
    turn(0, [message('user', 'hello')]);
    expect(await priorConversationBlock('s')).toBeNull();
  });

  it('carries the turns below the boundary and says they are history; later turns are the new engine\'s own', async () => {
    seed({ priorTurnsBefore: 1 });
    turn(0, [message('user', 'name the group'), { kind: 'execute-tool-call', id: 'x', seq: 1 }, message('assistant', 'created it')]);
    turn(1, [message('user', 'after the replacement')]);
    const block = await priorConversationBlock('s');
    expect(block).toMatch(/^<gugu_prior_conversation>/);
    expect(block).toContain('do not redo');
    expect(block).toContain('Person: name the group\n(tools used: Bash)\nAgent: created it');
    expect(block).not.toContain('after the replacement');
  });

  it('a first turn that never finished has no rows: the recorded first utterance is the prior conversation', async () => {
    seed({ priorTurnsBefore: 0, firstUtterance: 'run the tests' });
    expect(await priorConversationBlock('s')).toContain('Person: run the tests');
  });

  it('keeps the newest turns within the budget and says it cut', async () => {
    seed({ priorTurnsBefore: 10 });
    for (let seq = 0; seq < 10; seq += 1) turn(seq, [message('user', `${seq}:${'x'.repeat(7_000)}`)]);
    const block = (await priorConversationBlock('s'))!;
    expect(block).toContain('[Earlier part omitted for length.]');
    expect(block).toContain('Person: 9:');
    expect(block).not.toContain('Person: 0:');
    expect(block.length).toBeLessThan(50_000);
  });
});
