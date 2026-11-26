import { openFixture } from '@tooling/utils/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDb } from '@main/db/client';
import { AutomationsService } from './automations-service';
import { insertRun } from './repo';

// 「已安排」一页一次读完每一行的最近一次与下一次:与逐行的 getLatestRun / getNextScheduledRun 同一个答案。

const mocks = vi.hoisted(() => ({ db: undefined as AppDb | undefined }));
vi.mock('@main/db/client', () => ({
  get db() {
    if (!mocks.db) throw new Error('Test database not initialized');
    return mocks.db;
  },
}));
vi.mock('@main/lib/events', () => ({ events: { emit: vi.fn() } }));
vi.mock('@main/core/sessions/archiveSession', () => ({ archiveSession: vi.fn() }));
vi.mock('./actions/sessionCreate', () => ({ executeSessionCreate: vi.fn() }));

const TRIGGER = { expr: '0 9 * * *', tz: 'UTC' };
const AGENT = { prompt: 'Check things', provider: 'claude', autoApprove: true };
let fixture: Awaited<ReturnType<typeof openFixture>>;

beforeEach(async () => {
  fixture = await openFixture('empty');
  mocks.db = fixture.db;
  fixture.sqlite.exec(`
    INSERT INTO projects (id, name, path, created_at, updated_at) VALUES ('project-1', 'P', '/repo', 0, 0);
    INSERT INTO automations (id, name, project_id, trigger_config, agent_config, enabled, created_at, updated_at) VALUES
      ('ran', 'Ran', 'project-1', '${JSON.stringify(TRIGGER)}', '${JSON.stringify(AGENT)}', 1, 0, 0),
      ('fresh', 'Fresh', 'project-1', '${JSON.stringify(TRIGGER)}', '${JSON.stringify(AGENT)}', 1, 0, 0),
      ('never', 'Never', 'project-1', '${JSON.stringify(TRIGGER)}', '${JSON.stringify(AGENT)}', 0, 0, 0);
    INSERT INTO automations (id, name, project_id, trigger_config, agent_config, enabled, created_at, updated_at, deleted_at)
      VALUES ('gone', 'Gone', 'project-1', '${JSON.stringify(TRIGGER)}', '${JSON.stringify(AGENT)}', 1, 0, 0, 5);
  `);
});
afterEach(() => {
  fixture?.close();
  mocks.db = undefined;
});

describe('listRunHeads', () => {
  it('每个安排的最近一次与下一次,一条语句,答案与逐行读的相同', async () => {
    const run = (automationId: string, status: 'done' | 'failed' | 'scheduled', at: number) =>
      insertRun({ automationId, status, triggerKind: 'cron', triggerConfigSnapshot: TRIGGER, agentConfigSnapshot: AGENT,
        ...(status === 'scheduled' ? { scheduledAt: at } : { scheduledAt: at, startedAt: at, finishedAt: at + 1 }) });
    await run('ran', 'done', 100);
    const latest = await run('ran', 'failed', 200);
    const next = await run('ran', 'scheduled', 400);
    await run('ran', 'scheduled', 500);
    const only = await run('fresh', 'scheduled', 300);
    await run('gone', 'done', 100);
    fixture.sqlite.exec(`INSERT INTO sessions (id, project_id, config, automation_run_id)
      VALUES ('s-latest', 'project-1', json_object('version', '1', 'type', 'pty'), '${latest.id}')`);

    const service = new AutomationsService();
    const heads = await service.listRunHeads();

    expect(Object.keys(heads).sort()).toEqual(['fresh', 'ran']);
    expect(heads.ran).toEqual({ latest: await service.getLatestRun('ran'), next: await service.getNextScheduledRun('ran') });
    expect(heads.ran).toMatchObject({ latest: { id: latest.id, sessionId: 's-latest' }, next: { id: next.id } });
    expect(heads.fresh).toEqual({ latest: null, next: await service.getNextScheduledRun('fresh') });
    expect(heads.fresh?.next?.id).toBe(only.id);
  });
});
