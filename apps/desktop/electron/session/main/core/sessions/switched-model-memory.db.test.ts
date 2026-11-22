import { openFixture } from '@tooling/utils/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import type { TranscriptTurn } from '@gugu/session-core/acp';
import type { AppDb } from '@main/db/client';

const mocks = vi.hoisted(() => ({ db: undefined as AppDb | undefined, sqlite: undefined as Database.Database | undefined, emit: vi.fn() }));

vi.mock('@main/db/client', () => ({
  get db() {
    if (!mocks.db) throw new Error('Test database not initialized');
    return mocks.db;
  },
  get sqlite() { return mocks.sqlite; },
}));
vi.mock('@main/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@main/lib/events', () => ({ events: { emit: mocks.emit } }));
vi.mock('../activity/signals', () => ({ activitySignal: vi.fn() }));
vi.mock('@main/core/agent-status/agent-status-writer', () => ({ agentStatusWriter: { on: () => () => {} } }));

const { recordLiveModelSwitch } = await import('./live-model-switch');
const { settleSwitchedModelMemory } = await import('./switched-model-memory');
const { SettingsStore } = await import('@main/core/settings/settings-service');
const { observeCommittedTurn } = await import('./committed-turn-observer');
const { newSessionMemoryChangedChannel } = await import('@shared/core/sessions/sessionEvents');

const OWN_MODEL = 'custom:conn-1:beta-context-echo';
const started = { provider: 'codex', model: OWN_MODEL, permissionMode: 'full-access', providerChosenByUser: true } as const;

/**
 * #3293 Started on an own model, switched to a platform one in the session: once that model's first reply succeeds,
 * a new session preselects it (model-access.md 「上次使用的模型」). A switch whose first reply fails is not remembered.
 */
describe('switched model memory', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;
  /** A fresh store reads the row, not a cache: what the box sees after a page refresh or a restart. */
  const memory = () => new SettingsStore().get('newSessionMemory');
  const turn = (kind: 'done' | 'error' | 'cancelled') =>
    settleSwitchedModelMemory('conv-1', kind === 'error' ? { kind, reason: 'prompt_failed' } as never : { kind });

  beforeEach(async () => {
    fixture = await openFixture('empty');
    mocks.db = fixture.db;
    mocks.sqlite = fixture.sqlite;
    mocks.emit.mockClear();
    fixture.sqlite.exec(`
      INSERT INTO projects (id, name, path) VALUES ('project-1', 'Project', '/repo');
      INSERT INTO sessions (id, project_id, provider, runtime, config)
        VALUES ('conv-1', 'project-1', 'codex', 'acp', '{"version":"1","type":"acp","model":"${OWN_MODEL}"}');
    `);
    await new SettingsStore().update('newSessionMemory', { lastPicked: 'codex', lastStarted: started, sessionView: 'general' });
  });

  afterEach(() => {
    fixture.close();
    mocks.db = undefined;
    mocks.sqlite = undefined;
  });

  it('remembers the switched-to model once its first reply succeeds, and keeps it across a re-read', async () => {
    await recordLiveModelSwitch({ sessionId: 'conv-1', modelId: 'gpt-6-luna', source: 'platform' });
    expect((await memory()).lastStarted).toEqual(started); // the switch alone is not a use

    await turn('done');

    expect((await memory()).lastStarted).toEqual({
      provider: 'codex', platformModel: 'gpt-6-luna', permissionMode: 'full-access', providerChosenByUser: true,
    });
    expect((await memory()).lastPicked).toBe('codex');
    expect(mocks.emit).toHaveBeenCalledWith(newSessionMemoryChangedChannel, {});
  });

  it('the committed-turn observer settles it: a live reply after the switch updates the memory', async () => {
    await recordLiveModelSwitch({ sessionId: 'conv-1', modelId: 'gpt-6-luna', source: 'platform' });
    const reply = { id: 'conv-1:turn:0', seq: 0, initiator: 'user', startedAt: 1, endedAt: 2, outcome: { kind: 'done', reason: 'end_turn' },
      items: [{ kind: 'message', id: 'conv-1:turn:0:in', seq: 0, role: 'user', text: 'hi' },
        { kind: 'message', id: 'conv-1:turn:0:out', seq: 1, role: 'assistant', text: 'hello' }] } as TranscriptTurn;

    await observeCommittedTurn({ sessionId: 'conv-1', source: 'live', turn: reply });

    await vi.waitFor(async () => expect((await memory()).lastStarted?.platformModel).toBe('gpt-6-luna'));
  });

  it('does not remember a switch whose first reply fails, nor a later reply of that session', async () => {
    await recordLiveModelSwitch({ sessionId: 'conv-1', modelId: 'gpt-6-luna', source: 'platform' });
    await turn('error');
    await turn('done');

    expect((await memory()).lastStarted).toEqual(started);
    expect(mocks.emit).not.toHaveBeenCalled();
  });

  it('a stopped reply keeps waiting for the next one; replies without a switch change nothing', async () => {
    await turn('done');
    expect((await memory()).lastStarted).toEqual(started);

    await recordLiveModelSwitch({ sessionId: 'conv-1', modelId: 'gpt-6-luna', source: 'platform' });
    await turn('cancelled');
    expect((await memory()).lastStarted).toEqual(started);
    await turn('done');
    expect((await memory()).lastStarted?.platformModel).toBe('gpt-6-luna');
  });

  it('switching back to an own model remembers it in the model half, not as a platform choice', async () => {
    await recordLiveModelSwitch({ sessionId: 'conv-1', modelId: 'gpt-6-luna', source: 'platform' });
    await turn('done');
    await recordLiveModelSwitch({ sessionId: 'conv-1', modelId: OWN_MODEL, source: 'own' });
    await turn('done');

    expect((await memory()).lastStarted).toEqual(started);
  });
});
