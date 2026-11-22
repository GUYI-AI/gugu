import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ journal: { list: vi.fn(), get: vi.fn() }, recordHistoryPage: vi.fn(), recordTurns: vi.fn() }));
vi.mock('./collector', () => ({ activityJournal: () => mocks.journal }));
vi.mock('@main/core/session-timeline/service', () => ({ recordHistoryPage: mocks.recordHistoryPage, recordTurns: mocks.recordTurns }));
import { runActivityAction } from './actions';
beforeEach(() => vi.clearAllMocks());

describe('activity metadata and on-demand context have separate read paths', () => {
  it('metadata query never opens the original record', async () => {
    mocks.journal.list.mockReturnValue({ events: [], coverage: { scope: 'this_machine' } });
    await runActivityAction({ action: 'activity_list', since: '2026-10-20T00:00:00Z', until: '2026-10-21T00:00:00Z' });
    expect(mocks.journal.list).toHaveBeenCalledOnce();
    expect(mocks.recordHistoryPage).not.toHaveBeenCalled();
  });
  it('filters by a group and answers with the events as the journal files them', async () => {
    const events = [{ event_id: 'e1', chat_id: 'chat1' }, { event_id: 'e3' }];
    mocks.journal.list.mockReturnValue({ events });
    const query = { since: '2026-10-20T00:00:00Z', until: '2026-10-21T00:00:00Z', chat_id: 'chat1' };
    expect(await runActivityAction({ action: 'activity_list', ...query })).toEqual({ events });
    expect(mocks.journal.list).toHaveBeenCalledWith(query);
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
  it('reads a turn event as the turn of the record that has the key the agent numbered in it', async () => {
    mocks.journal.get.mockReturnValue({ event_id: 'e3', kind: 'session.turn_recorded', session_id: 's1', object_id: 's1:turn:7', related_object_id: 'tool:call-2' });
    mocks.recordTurns.mockResolvedValue([
      { id: 'r1', seq: 0, items: [{ kind: 'message', id: 'r1:message:m1', role: 'user', text: 'first' }] },
      { id: 'r2', seq: 1, items: [{ kind: 'execute-tool-call', id: 'r2:tool', toolCallId: 'call-2' }] },
    ]);
    expect(await runActivityAction({ action: 'activity_context', event_id: 'e3' }))
      .toMatchObject({ scope: 'event_turn', event_anchored: true, has_older: true, next_before_seq: 1, context: [{ id: 'r2' }] });
    expect(mocks.recordHistoryPage).not.toHaveBeenCalled();
  });
  it('reads a turn event whose turn the record no longer has (a revert) as the latest turns, unanchored', async () => {
    mocks.journal.get.mockReturnValue({ event_id: 'e4', kind: 'session.turn_recorded', session_id: 's1', related_object_id: 'tool:gone' });
    mocks.recordTurns.mockResolvedValue([{ id: 'r1', seq: 0, items: [] }]);
    mocks.recordHistoryPage.mockResolvedValue({ ok: true, value: { hasOlder: false, turns: [{ id: 'r1', seq: 0, items: [] }] } });
    expect(await runActivityAction({ action: 'activity_context', event_id: 'e4' }))
      .toMatchObject({ event_anchored: false, scope: 'latest_four_turns', context: [{ id: 'r1' }] });
  });
});
