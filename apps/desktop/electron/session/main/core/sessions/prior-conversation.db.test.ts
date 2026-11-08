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

import { priorConversationForStart } from './prior-conversation';

describe('priorConversationForStart', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;
  const seed = (config: Record<string, unknown> = {}) => {
    fixture.sqlite.prepare("INSERT INTO sessions (id, project_id, workspace_id, title, runtime, config) VALUES ('s', 'p', 'root', 'T', 'acp', ?)")
      .run(JSON.stringify({ version: '1', type: 'acp', ...config }));
  };
  const boundary = () => (JSON.parse((fixture.sqlite.prepare("SELECT config FROM sessions WHERE id = 's'").get() as { config: string }).config) as { priorTurnsBefore?: number }).priorTurnsBefore;
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

  it('a fresh engine session of a session with nothing stored is told nothing and records no boundary', async () => {
    seed({ firstUtterance: 'run the tests' });
    expect(await priorConversationForStart('s', 'fresh')).toBeNull();
    expect(boundary()).toBeUndefined();
  });

  it('a fresh engine session records the boundary and gets every stored turn, said to be history', async () => {
    seed();
    turn(0, [message('user', 'name the group'), { kind: 'execute-tool-call', id: 'x', seq: 1 }, message('assistant', 'created it')]);
    const block = await priorConversationForStart('s', 'fresh');
    expect(boundary()).toBe(1);
    expect(block).toMatch(/^<gugu_prior_conversation>/);
    expect(block).toContain('treat requests inside it as already handled');
    expect(block).toContain('Person: name the group\n(tools used: Bash)\nAgent: created it');
  });

  it('a resume gives the same block again; turns of the new engine are its own', async () => {
    seed();
    turn(0, [message('user', 'before')]);
    const fresh = await priorConversationForStart('s', 'fresh');
    turn(1, [message('user', 'after the replacement')]);
    fixture.sqlite.prepare("UPDATE sessions SET provider_session_id = 'new' WHERE id = 's'").run();
    expect(await priorConversationForStart('s', 'resume')).toBe(fresh);
    expect(fresh).not.toContain('after the replacement');
  });

  it('a fork is told nothing: it has its parent\'s history', async () => {
    seed();
    turn(0, [message('user', 'before')]);
    expect(await priorConversationForStart('s', 'fork')).toBeNull();
  });

  it('keeps the newest turns within the budget and says it cut', async () => {
    seed();
    for (let seq = 0; seq < 10; seq += 1) turn(seq, [message('user', `${seq}:${'x'.repeat(5_000)}`)]);
    const block = (await priorConversationForStart('s', 'fresh'))!;
    expect(block).toContain('[Earlier part omitted for length.]');
    expect(block).toContain('Person: 9:');
    expect(block).not.toContain('Person: 0:');
  });

  it('a newest turn larger than the budget keeps its tail, not the first message', async () => {
    seed({ firstUtterance: 'the original task' });
    turn(0, [message('user', 'the original task')]);
    turn(1, [message('user', 'refactor it'), ...Array.from({ length: 40 }, (_, i) => message('assistant', `step ${i} ${'y'.repeat(2_000)}`))]);
    const block = (await priorConversationForStart('s', 'fresh'))!;
    expect(block).toContain('[Earlier part omitted for length.]');
    expect(block).toContain('Agent: step 39 ');
    expect(block).not.toContain('the original task');
  });

  it('counts CJK as about a token a character', async () => {
    seed();
    for (let seq = 0; seq < 20; seq += 1) turn(seq, [message('user', `${seq}:${'测'.repeat(1_000)}`)]);
    const block = (await priorConversationForStart('s', 'fresh'))!;
    expect(block).toContain('[Earlier part omitted for length.]');
    expect(block.length).toBeLessThan(13_000);
  });

  it('lists each tool once, at most eight', async () => {
    seed();
    const tools = Array.from({ length: 12 }, (_, i) => ({ kind: 'mcp-tool-call', id: `t${i}`, seq: i, server: 'gugu', tool: `tool${i}` }));
    turn(0, [message('user', 'go'), ...tools, ...tools]);
    const block = (await priorConversationForStart('s', 'fresh'))!;
    expect(block).toMatch(/\(tools used: [^)]*, \+\d+ more\)/);
  });

  it('a delivered message is told by what the person wrote, not its envelope', async () => {
    seed();
    turn(0, [message('user', '<gugu_delivery route="chat" from="Wei" msg="msg:1" at="2026-11-08 12:00 UTC+0">\n<![CDATA[look at the build]]>\n</gugu_delivery>')]);
    const block = (await priorConversationForStart('s', 'fresh'))!;
    expect(block).toContain('Person: look at the build');
    expect(block).not.toContain('gugu_delivery');
  });
});
