/** @jsxImportSource solid-js */
/**
 * running-row-removal.contract — a running tool row must leave nothing behind
 * when its row goes away.
 *
 * ## What broke
 *
 * A queued follow-up that is dequeued at turn end replaces the finished turn's
 * frame with a one-line placeholder, so the tool rows' indices disappear from
 * the timeline. On the desktop app that write threw
 * `Cannot read properties of undefined (reading 'data')` out of the Solid
 * update, the pass was dropped and the whole transcript pane went blank until a
 * reload. (The ownerless computation lived in the label's sweep `animationend`
 * handler; running labels no longer animate, and this pins the swap itself.)
 */

import { createChatContext } from '@session-chat/chat-context';
import { createChatView } from '@session-chat/chat-view';
import { DEFAULT_THEME } from '@session-chat/core/theme';
import type { TranscriptTurn } from '@session-chat/model';
import { createChatState } from '@session-chat/state/chat-state';
import { runningText } from '@session-chat/styles/effects.css';
import { afterEach, describe, expect, it } from 'vitest';
import { until } from '../../../../tests/support/awaitCondition';

type Item = TranscriptTurn['items'][number];

// Shapes copied from a dequeue on the desktop app (`sleep 40`, then the reply).
const TURN = 'sess:turn:s0';
const userAsk = { kind: 'message', id: `${TURN}:message:u`, seq: 0, role: 'user', text: 'Run sleep 40, then echo step2.' };
const sleepCall = (status: 'running' | 'done') => ({
  kind: 'execute-tool-call', id: `${TURN}:tool:c1`, seq: 1, toolCallId: 'c1', title: 'sleep 40', status,
  toolName: 'Bash', command: 'sleep 40', ...(status === 'done' ? { outputText: '(Bash completed with no output)' } : {}),
});
const echoCall = { kind: 'execute-tool-call', id: `${TURN}:tool:c2`, seq: 2, toolCallId: 'c2', title: 'echo step2', status: 'done',
  toolName: 'Bash', command: 'echo step2', outputText: 'step2' };
const reply = { kind: 'message', id: `${TURN}:message:r`, seq: 3, role: 'assistant', text: 'FIRSTDONE' };
const frame = (items: unknown[]): TranscriptTurn =>
  ({ id: TURN, seq: 0, initiator: 'user', startedAt: 1, items: items as Item[] }) as TranscriptTurn;
// acp-chat-store's queuedPromptTurn: the dequeued message, alone, until the real turn arrives.
const QUEUED_TEXT = 'Also add one more line to your final answer.';
const queuedPlaceholder = {
  id: 'queued:q1', seq: 0, initiator: 'user',
  items: [{ kind: 'message', id: 'q1', seq: 0, role: 'user', text: QUEUED_TEXT }],
} as TranscriptTurn;

const teardown: Array<() => void> = [];
afterEach(() => {
  while (teardown.length > 0) teardown.pop()?.();
});

async function mount() {
  const ctx = createChatContext({ locale: () => 'en-US', theme: DEFAULT_THEME });
  const state = createChatState(ctx);
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;top:0;left:0;width:800px;height:700px;';
  document.body.appendChild(host);
  const view = createChatView({ context: ctx, state, parent: host });
  teardown.push(() => {
    view.dispose();
    ctx.dispose();
    state.dispose();
    host.remove();
  });
  return { host, state };
}

async function dequeueAfterRunningTool() {
  const { host, state } = await mount();
  state.transcript.activeTurn.set(frame([userAsk, sleepCall('running')]));
  await until('the running tool row is drawn', () => host.querySelector(`.${runningText}`) !== null);
  state.transcript.activeTurn.set(frame([userAsk, sleepCall('done'), echoCall, reply]));
  await until('the finished turn is on screen', () => host.innerText.includes('FIRSTDONE'));

  let thrown: unknown = null;
  try {
    state.transcript.activeTurn.set(queuedPlaceholder);
  } catch (error) {
    thrown = error;
  }
  return { host, thrown };
}

describe('a running row leaves nothing behind when it is removed', () => {
  it('the frame swap does not throw and the pane keeps drawing', async () => {
    const { host, thrown } = await dequeueAfterRunningTool();
    expect(thrown, `the swap threw: ${String((thrown as Error | null)?.message)}`).toBeNull();
    await until('the queued message is drawn', () => host.innerText.includes(QUEUED_TEXT));
  });
});
