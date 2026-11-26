/** @jsxImportSource solid-js */
import { AcpTranscriptParser, decodeV2SessionUpdate } from '@gugu/session-core/acp';
import { trimCursorPageForTransport, TRANSPORT_TEXT_LIMIT, TRANSPORT_PAYLOAD_BUDGET } from '@gugu/session-core/session-record/transport-trim';
import { createClaudeSessionDecoder } from '../../../session-plugins/src/agents/impl/claude/acp-transform';
import { createChatContext } from '@session-chat/chat-context';
import { createChatView } from '@session-chat/chat-view';
import { createChatState } from '@session-chat/state/chat-state';
import { expect, it } from 'vitest';
import { until } from '../../../../tests/support/awaitCondition';

it.each(['codex', 'claude'] as const)('%s MCP identity and disclosure survive live completion and local history reopening', async provider => {
  const parser = new AcpTranscriptParser({ sessionId: `${provider}-mcp-details` });
  const decode = provider === 'claude' ? createClaudeSessionDecoder() : decodeV2SessionUpdate;
  const name = 'mcp__fixture__lookup';
  const request = { query: 'needle-3327', limit: 2 };
  const result = 'A returned detail beyond the former preview. '.repeat(20) + 'RESULT-END-3327';
  const context = createChatContext({ locale: () => 'en-US', layout: { preset: 'double', userGutter: 0, agentConversation: true } });
  const state = createChatState(context);
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;inset:0;width:900px;height:1600px';
  document.body.append(host);
  let view = createChatView({ context, state, parent: host });
  const run = () => host.querySelector<HTMLButtonElement>('[data-slot="tool-run"] [data-collapse-id]');
  const trigger = () => host.querySelector<HTMLElement>('[data-slot="tool-call-trigger"]');
  const send = (update: Record<string, unknown>) => {
    parser.pushEvent(decode(update), 1000);
    state.transcript.activeTurn.set(parser.activeTurn);
  };
  try {
    state.session.setGenerating(true);
    // Codex supplies arguments at start. Claude can announce the call before its input arrives.
    send({ sessionUpdate: 'tool_call_update', toolCallId: 'lookup', title: name, name, kind: 'other', status: 'in_progress',
      rawInput: provider === 'claude' ? {} : request });
    await until('the live process counts the MCP call', () => run()?.textContent?.includes('Called 1 MCP tool') === true);
    expect(host.querySelector('[data-conversation-process]')?.getAttribute('aria-expanded')).toBe('true');
    expect(trigger()).toBeNull();
    run()!.click();
    await until('the disclosed MCP row identifies its server and tool', () => trigger()?.textContent?.includes('fixture, lookup') === true);
    expect(host.querySelector('[data-slot="tool-call-request"]')).toBeNull();
    expect(trigger()!.getAttribute('aria-expanded')).toBe('false');
    trigger()!.click();
    await until('MCP disclosure opens', () => trigger()?.getAttribute('aria-expanded') === 'true');
    if (provider === 'claude') send({ sessionUpdate: 'tool_call_update', toolCallId: 'lookup', rawInput: request });
    await until('the actual arguments appear', () => host.querySelector('[data-slot="tool-call-request"]')?.textContent?.includes('needle-3327') === true);
    // Completion may omit the arguments. The shared parser must preserve them and add the returned content.
    send({ sessionUpdate: 'tool_call_update', toolCallId: 'lookup', status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: result } }] });
    await until('the completed result appears in the open panel', () => host.querySelector('[data-slot="tool-call-result"]')?.textContent?.includes('RESULT-END-3327') === true);
    expect(host.querySelector('[data-slot="tool-call-request"]')?.textContent).toContain('needle-3327');
    trigger()!.click();
    await until('MCP disclosure closes', () => trigger()?.getAttribute('aria-expanded') === 'false');
    run()!.click();
    await until('the summary hides the raw MCP row again', () => trigger() === null);
    parser.endTurn();
    const page = trimCursorPageForTransport({ turns: [...parser.history], nextCursor: null }, TRANSPORT_TEXT_LIMIT, TRANSPORT_PAYLOAD_BUDGET, false);
    state.transcript.activeTurn.set(null);
    state.transcript.history.seed(page.turns);
    state.session.setGenerating(false);
    view.dispose();
    view = createChatView({ context, state, parent: host });
    // A running process starts open, and a finished one starts closed.
    const process = () => host.querySelector<HTMLButtonElement>('[data-conversation-process]');
    await until('the reopened history process starts closed', () => process()?.getAttribute('aria-expanded') === 'false');
    process()!.click();
    await until('the reopened process shows the same MCP count', () => run()?.textContent?.includes('Called 1 MCP tool') === true);
    expect(trigger()).toBeNull();
    run()!.click();
    await until('the reopened local MCP row retains its identity', () => trigger()?.textContent?.includes('fixture, lookup') === true);
    expect(trigger()!.getAttribute('aria-expanded')).toBe('false');
    trigger()!.click();
    await until('local history retains the complete result below the old preview limit', () => host.querySelector('[data-slot="tool-call-result"]')?.textContent?.includes('RESULT-END-3327') === true);
    expect(host.querySelector('[data-slot="tool-call-request"]')?.textContent).toContain('needle-3327');
  } finally {
    view.dispose(); state.dispose(); context.dispose(); host.remove();
  }
});
