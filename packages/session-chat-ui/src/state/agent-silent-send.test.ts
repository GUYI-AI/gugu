import { describe, expect, it } from 'vitest';
import type { ItemSegmenter, SegmentCtx } from '../core/units';
import { unit } from '../core/units';
import { defaultChatTranslator as translate } from '../localization';
import type { TranscriptTurn } from '../model';
import { flattenTier } from './flatten';
import type { AgentActivityGroup } from './agent-activity';

const peer = 'user:11111111-1111-4111-8111-111111111111';
const ctx = { isCollapsed: () => false, pendingToolCallIds: () => new Set(),
  agentConversation: true, foldTurnProcess: true, translate,
  actor: (id: string) => id === peer ? { id, name: 'Peer', type: 'agent' } : null,
  chatName: () => 'Project', chatKind: () => 'group' } as unknown as SegmentCtx;
const segmenters: Record<string, ItemSegmenter> = {
  message: { kind: 'message', segment: item => [unit('message', item, item, { key: 'self' })] },
  'turn-process': { kind: 'turn-process', segment: item => [unit('turn-process', item, item, { key: 'self' })] },
  'subagent-done-tool-call': { kind: 'subagent-done-tool-call', segment: item => [unit('subagent-done-tool-call', item, item, { key: 'self' })] },
};
const quiet = (id: string): TranscriptTurn => ({ id, seq: 0, initiator: 'agent', outcome: { kind: 'done' },
  items: [{ kind: 'message', id: `${id}-silence`, seq: 2, role: 'assistant', text: '[NO_REPLY]' }] });
const sent = (id: string): TranscriptTurn => ({ ...quiet(id), items: [
  { kind: 'mcp-tool-call', id: `${id}-send`, toolCallId: `${id}-send`, seq: 1, title: 'Send',
    server: 'gugu', tool: 'message_send', status: 'done',
    rawInput: JSON.stringify({ chat_id: 'group', to_user_ids: [peer], text: `Update ${id}` }),
    outputText: 'sent (id=msg:6417511d-8f36-4cbc-8cbb-81ce9f97df73)' }, ...quiet(id).items,
] });

describe('settled silence between confirmed Agent sends', () => {
  it('does not put a standalone silence process between adjacent activity summaries', () => {
    const rows = flattenTier([sent('first'), quiet('middle'), sent('last')], ctx, segmenters);
    const groups = rows.filter(row => row.kind === 'agent-activity');
    expect(groups).toHaveLength(1);
    expect((groups[0].data as AgentActivityGroup).events.reduce((sum, event) => sum + event.count, 0)).toBe(2);
    expect(rows.filter(row => row.kind === 'turn-process' && !row.activityFold)).toHaveLength(0);
    expect(rows.filter(row => row.itemId.includes(':sent:')).every(row => row.activityFold === groups[0].id)).toBe(true);
  });

  it('keeps an unconfirmed send process visible even when followed by silence', () => {
    const failed = sent('unconfirmed');
    const call = failed.items[0];
    if (call.kind !== 'mcp-tool-call') throw new Error('fixture');
    call.outputText = 'Delivery could not be confirmed.';
    const rows = flattenTier([sent('first'), failed, sent('last')], ctx, segmenters);
    expect(rows.some(row => row.kind === 'turn-process' && !row.activityFold)).toBe(true);
    expect(rows.filter(row => row.kind === 'agent-activity')).toHaveLength(2);
  });

  it.each(['failed', 'permission', 'live'] as const)('keeps %s work visible beside confirmed sends', state => {
    const record = sent(state);
    const call = record.items[0];
    if (call.kind !== 'mcp-tool-call') throw new Error('fixture');
    call.status = state === 'failed' ? 'error' : 'running';
    call.outputText = state === 'failed' ? 'Delivery failed.' : '';
    if (state === 'live') {
      delete record.outcome;
      call.tool = 'message_history';
      call.rawInput = JSON.stringify({ chat_id: 'group' });
    }
    const rows = flattenTier([sent('first'), record], { ...ctx,
      active: state === 'live', revealAllFolds: true,
      pendingToolCallIds: () => new Set(state === 'permission' ? [call.toolCallId] : []),
    }, { ...segmenters,
      'mcp-tool-call': { kind: 'mcp-tool-call', segment: item => [unit('mcp-tool-call', item, item, { key: 'self' })] },
    });
    expect(rows.some(row => row.kind === 'turn-process' && !row.activityFold)).toBe(true);
    expect(rows.find(row => row.itemId === call.id)?.activityFold).toBeUndefined();
    expect(rows.some(row => row.itemId === call.id)).toBe(true);
  });

  it('keeps the actual live process visible before the turn has settled', () => {
    const live = { ...quiet('live'), outcome: undefined };
    expect(flattenTier([live], { ...ctx, active: true }, segmenters).some(row => row.kind === 'turn-process')).toBe(true);
  });

  it('keeps the latest independent silent acknowledgement visible', () => {
    const rows = flattenTier([quiet('latest')], ctx, segmenters);
    expect(rows.some(row => row.kind === 'turn-process' && !row.activityFold)).toBe(true);
  });

  it('does not give a new silent turn the preceding turn\'s Agent send identity', () => {
    const rows = flattenTier([sent('older'), quiet('latest')], ctx, segmenters);
    expect(rows.some(row => row.itemId === 'latest:process' && !row.activityFold)).toBe(true);
  });

  it('keeps the latest silent completion after a confirmed send to a human', () => {
    const rows = flattenTier([sent('human')], { ...ctx,
      actor: (id: string) => ({ id, name: 'Person', type: 'human' }),
    }, segmenters);
    expect(rows.some(row => row.kind === 'turn-process' && !row.activityFold)).toBe(true);
    expect(rows.filter(row => row.kind === 'agent-activity')).toHaveLength(0);
  });

  it('preserves a real scheduled input followed by silence as a visible boundary', () => {
    const scheduled: TranscriptTurn = { ...quiet('scheduled'), trigger: { kind: 'schedule' }, items: [
      { kind: 'message', id: 'scheduled-input', seq: 0, role: 'user', text:
        '<gugu_delivery route="scheduled" from="咕咕系统" from_id="system:gugu" schedule="Check report" msg="msg:scheduled"><![CDATA[Check the report]]></gugu_delivery>' }, ...quiet('scheduled').items,
    ] };
    const rows = flattenTier([sent('first'), scheduled, sent('last')], ctx, segmenters);
    expect(rows.find(row => row.itemId === 'scheduled-input')?.activityFold).toBeUndefined();
    expect(rows.some(row => row.itemId === 'scheduled-input')).toBe(true);
    expect(rows.filter(row => row.kind === 'agent-activity')).toHaveLength(2);
  });

  // #2587: the completion continues the agent's work instead of standing as its own row. A confirmed send already sealed the
  // segment before it, so it carries on in a process line of its own, still outside the A2A fold.
  it('keeps a background completion after a send visible as a process line followed by silence', () => {
    const notice: TranscriptTurn = { ...quiet('background'), items: [
      { kind: 'subagent-done-tool-call', id: 'completed-child', seq: 0, toolCallId: 'completed-child',
        title: 'Background task finished', status: 'done', name: 'Report', agentId: 'child',
        launchToolCallId: 'launch', outcome: 'completed' }, ...quiet('background').items,
    ] };
    const rows = flattenTier([sent('first'), notice, sent('last')], ctx, segmenters);
    expect(rows.some(row => row.itemId === 'completed-child')).toBe(false);
    expect(rows.filter(row => row.kind === 'turn-process' && !row.activityFold)).toHaveLength(1);
    const expanded = flattenTier([sent('first'), notice, sent('last')], { ...ctx, revealAllFolds: true }, segmenters);
    expect(expanded.some(row => row.itemId === 'completed-child')).toBe(true);
    expect(rows.filter(row => row.kind === 'agent-activity')).toHaveLength(2);
  });
});
