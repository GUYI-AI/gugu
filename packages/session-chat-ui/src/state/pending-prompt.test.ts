import { describe, expect, it } from 'vitest';
import { renderDeliveryEnvelope } from '@gugu/core/local/agent/deliveryEnvelope';
import type { TranscriptTurn } from '../model';
import { activeTurnWithInputs, latestVisibleTurnId, pendingEchoes, pendingPromptLanded, pendingPromptNativeEcho, type PendingPrompt } from './pending-prompt';

/**
 * @@@echo-index — an input waiting for its echo is looked for among the turns' user messages. Every way an echo is
 * recognised (native identity, client id, id, delivery source ids, text after its anchor, baseline excluded) is pinned
 * here, with several inputs at once: however the turns are read, each input must find exactly this echo.
 */
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const delivery = (n: number, body: string) => renderDeliveryEnvelope({ route: 'chat', from: 'd3', fromId: 'user:peer', fromType: 'human',
  messageId: `msg:${uuid(n)}`, at: '2026-11-24 01:00 UTC+0', chat: 'group', chatKind: 'group', content: body });
const user = (id: string, text: string, meta?: Record<string, unknown>) => ({ kind: 'message', id, seq: 0, role: 'user', text, ...(meta ? { _meta: meta } : {}) });
const said = (id: string) => ({ kind: 'message', id, seq: 0, role: 'assistant', text: 'ok' });
const turn = (id: string, items: unknown[]): TranscriptTurn => ({ id, seq: 0, initiator: 'user', outcome: { kind: 'done' }, items: items as TranscriptTurn['items'] });

const committed = [
  turn('t1', [user('t1:u1', 'old words'), said('t1:a1')]),
  turn('t2', [user('t2:u1', 'same words'), said('t2:a1'), user('native-7', 'by native id'), said('t2:a2')]),
];
const active = turn('t3', [
  user('t3:u1', delivery(1, 'first delivery')), said('t3:a1'),
  user('t3:u2', 'typed by hand', { guguClientMessageId: 'client-1' }), said('t3:a2'),
  user('t3:prompt-0123456789abcdef', 'id inside'), said('t3:a3'),
  user('t3:u4', 'same words'), said('t3:a4'),
  user('t3:u5', delivery(2, 'second delivery')),
  user('t3:u6', 'same words'),
]);
const inputs: PendingPrompt[] = [
  { id: 'p-native', text: 'x', nativeEcho: { turnId: 't2', itemId: 'native-7' } },
  { id: 'client-1', text: 'typed by hand' },
  { id: 'prompt-0123456789abcdef', text: 'id inside' },
  { id: 't3:u4', text: 'whatever' },
  { id: 'p-delivery-1', text: delivery(1, 'first delivery'), received: true, delivery: { state: 'accepted' } },
  { id: 'p-delivery-2', text: delivery(2, 'second delivery'), received: true, delivery: { state: 'receiving' } },
  { id: 'p-delivery-9', text: delivery(9, 'never arrived'), received: true, delivery: { state: 'waiting' } },
  { id: 'p-text-after-t2', text: 'same   words', afterTurnId: 't2' },
  { id: 'p-text-after-renumbered', text: 'same words', afterTurnId: 'gone', baselineMessageIds: ['t2:u1'] },
  { id: 'p-text-baseline', text: 'same words', afterTurnId: 't3', baselineMessageIds: ['t3:u6'] },
  { id: 'p-text-first', text: 'old words' },
  { id: 'p-text-first-baselined', text: 'old words', baselineMessageIds: ['x'] },
  { id: 'p-unmatched', text: 'nobody said this', afterTurnId: 't1' },
];

describe('an input waiting for its echo, among several', () => {
  it('finds exactly the pinned echo', async () => {
    const all = pendingEchoes([...committed, active]), activeOnly = pendingEchoes([active]);
    const pinned = {
      echoes: inputs.map(input => [input.id, pendingPromptNativeEcho(input, all) ?? null, pendingPromptLanded(input, all)]),
      activeOnly: inputs.map(input => [input.id, pendingPromptLanded(input, activeOnly)]),
      withInputs: activeTurnWithInputs(active, inputs[4]!, inputs, committed)?.items.map(item => item.id),
      withInputsNoTurn: activeTurnWithInputs(null, null, inputs.slice(6))?.items.map(item => item.id),
      latest: [latestVisibleTurnId(null, committed, null, inputs), latestVisibleTurnId(null, committed, null, inputs.slice(0, 2))],
    };
    await expect(JSON.stringify(pinned, null, 1)).toMatchFileSnapshot('./__pinned__/pending-prompt.echoes.json');
  });
});
