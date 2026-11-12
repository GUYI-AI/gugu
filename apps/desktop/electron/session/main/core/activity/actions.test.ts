import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ journal: { list: vi.fn(), get: vi.fn(), turnRevertedAfter: vi.fn() }, recordHistoryPage: vi.fn(),
  store: { readStoredTurn: vi.fn(), readStoredTurns: vi.fn() } }));
vi.mock('./collector', () => ({ activityJournal: () => mocks.journal }));
vi.mock('@main/core/session-timeline/service', () => ({ recordHistoryPage: mocks.recordHistoryPage }));
vi.mock('@main/core/sessions/session-turn-store', () => mocks.store);
vi.mock('../projects/project-public-id', () => ({
  machineLocalProjectsOf: async (id: string) => (id === 'chat1' ? ['p1', 'p1-joined'] : []),
  machineOutwardProjectIds: async () => (local: string) => (local.startsWith('p1') ? 'chat1' : null),
}));
import { runActivityAction } from './actions';
beforeEach(() => vi.clearAllMocks());

describe('activity metadata and on-demand context have separate read paths', () => {
  it('metadata query never opens the original record', async () => {
    mocks.journal.list.mockReturnValue({ events: [], coverage: { scope: 'this_machine' } });
    await runActivityAction({ action: 'activity_list', since: '2026-10-20T00:00:00Z', until: '2026-10-21T00:00:00Z' });
    expect(mocks.journal.list).toHaveBeenCalledOnce();
    expect(mocks.recordHistoryPage).not.toHaveBeenCalled();
  });
  it('filters by a project id as this machine’s folders of it and answers with the project id', async () => {
    mocks.journal.list.mockReturnValue({ events: [{ event_id: 'e1', project_id: 'p1-joined' }, { event_id: 'e2', project_id: 'loose' }, { event_id: 'e3' }] });
    const query = { since: '2026-10-20T00:00:00Z', until: '2026-10-21T00:00:00Z', project_id: 'chat1' };
    expect(await runActivityAction({ action: 'activity_list', ...query })).toEqual({ events: [{ event_id: 'e1', project_id: 'chat1' }, { event_id: 'e2' }, { event_id: 'e3' }] });
    expect(mocks.journal.list).toHaveBeenCalledWith(query, ['p1', 'p1-joined']);
  });
  it('on demand returns original input and latest reply, without tools or thinking', async () => {
    mocks.journal.get.mockReturnValue({ event_id: 'e1', session_id: 's1' });
    mocks.recordHistoryPage.mockResolvedValue({ ok: true, value: { hasOlder: true, turns: [{ id: 't1', seq: 1, items: [
      { id: 'i1', kind: 'message', role: 'user', text: 'Please check the task' },
      { id: 'i2', kind: 'thinking', text: 'internal thought' },
      { id: 'i3', kind: 'execute-tool-call', output: 'private process output' },
      { id: 'i4', kind: 'message', role: 'assistant', text: 'I sent a reminder' },
    ] }] } });
    const result = await runActivityAction({ action: 'activity_context', event_id: 'e1' });
    expect(mocks.recordHistoryPage).toHaveBeenCalledWith({ conversationId: 's1', limit: 4 });
    expect(result).toMatchObject({ context_available: true, source: 'provider_record', event_anchored: false, has_older: true, next_before_seq: 1,
      context: [{ inputs: [{ text: 'Please check the task' }], latest_reply: { text: 'I sent a reminder' } }] });
    expect(JSON.stringify(result)).not.toMatch(/internal thought|private process output/);
  });
  it('reports a missing original record without claiming an empty context', async () => {
    mocks.journal.get.mockReturnValue({ event_id: 'e2', session_id: 'deleted' });
    mocks.recordHistoryPage.mockResolvedValue({ ok: false, error: { code: 'session_not_found' } });
    expect(await runActivityAction({ action: 'activity_context', event_id: 'e2' })).toMatchObject({ context_available: false, reason: { code: 'session_not_found' } });
  });
  it('reads a turn event only from the stored history that numbered it, never from the provider record', async () => {
    mocks.journal.get.mockReturnValue({ event_id: 'e3', kind: 'session.turn_recorded', session_id: 's1', turn_seq: 7 });
    mocks.journal.turnRevertedAfter.mockReturnValue(false);
    mocks.store.readStoredTurn.mockResolvedValue({ id: 's1:turn:s7', seq: 7, items: [] });
    mocks.store.readStoredTurns.mockResolvedValue({ turns: [], originTurnIds: [], nextCursor: null });
    expect(await runActivityAction({ action: 'activity_context', event_id: 'e3' }))
      .toMatchObject({ scope: 'event_turn', event_anchored: true, source: 'stored_history', context: [{ id: 's1:turn:s7' }] });
    expect(mocks.store.readStoredTurn).toHaveBeenCalledWith('s1', 7);
    expect(mocks.recordHistoryPage).not.toHaveBeenCalled();
  });
});
