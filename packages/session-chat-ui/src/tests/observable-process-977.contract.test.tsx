/** @jsxImportSource solid-js */
import { afterEach, describe, expect, it } from 'vitest';
import { createChatContext } from '@session-chat/chat-context';
import { createChatView } from '@session-chat/chat-view';
import { createChatState } from '@session-chat/state/chat-state';
import type { TranscriptItem, TranscriptTurn } from '@session-chat/model';
import { until, untilStable } from '../../../../tests/support/awaitCondition';

const disposers: (() => void)[] = [];
afterEach(() => disposers.splice(0).forEach(dispose => dispose()));
const nativeName = 'mcp__plugin_gugu-product_gugu__message_send';
const pending: TranscriptItem = { kind: 'mcp-tool-call', id: 'send', seq: 1, toolCallId: 'send',
  title: nativeName, tool: 'message_send', server: 'plugin_gugu-product_gugu', status: 'running',
  rawInput: JSON.stringify({ chat_id: '977', text: 'Status update.' }) };

function mount(items: TranscriptItem[], trigger?: TranscriptTurn['trigger']) {
  const context = createChatContext({ locale: () => 'en-US' });
  context.setLayout({ preset: 'double', userGutter: 72, agentConversation: true });
  const state = createChatState(context);
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;inset:0;width:900px;height:1000px';
  document.body.append(host);
  const view = createChatView({ context, state, parent: host, commands: { conversationClock: () => 22000 } });
  disposers.push(() => { view.dispose(); state.dispose(); context.dispose(); host.remove(); });
  state.transcript.activeTurn.set({ id: 'live', seq: 0, initiator: trigger ? 'agent' : 'user',
    startedAt: 1000, ...(trigger ? { trigger } : {}), items });
  return { host, state, settle: () => untilStable('process layout settles', () => host.querySelector('[data-chat-canvas]')?.getBoundingClientRect().height) };
}

describe('observable conversation process', () => {
  it.each(['delivery', 'schedule', 'agent'] as const)('keeps a %s-triggered live header factual', async kind => {
    const v = mount([pending], { kind, ...(kind === 'delivery' ? { chatIds: ['977'] } : {}) });
    await until('live process appears', () => !!v.host.querySelector('[data-conversation-process]'));
    const header = v.host.querySelector('[data-conversation-process]')!;
    expect(header.textContent).toBe('Thinking and working 21s, 1 step›');
  });

  it('keeps other calls grouped while an unfinished MCP send identifies its server and tool', async () => {
    const v = mount([
      { kind: 'spawn-subagent-tool-call', id: 'spawn', seq: 0, toolCallId: 'spawn', title: 'Agent', status: 'done', name: 'helper' },
      { kind: 'unknown-tool-call', id: 'other', seq: 1, toolCallId: 'other', title: 'OtherNativeTool', name: 'OtherNativeTool', toolKind: 'other', status: 'done' },
      pending,
    ]);
    await until('process steps appear', () => !!v.host.querySelector('[data-slot="conversation-process-steps"]'));
    await v.settle();
    const runs = v.host.querySelectorAll('[data-slot="tool-run"]');
    expect(runs).toHaveLength(1);
    expect(runs[0].getAttribute('data-step-count')).toBe('2');
    expect(runs[0].textContent).not.toMatch(/MCP/i);
    expect(runs[0].textContent).toMatch(/launched 1 subagent/i);
    expect(runs[0].textContent).toContain('used 1 tool');
    expect(v.host.textContent).not.toContain(nativeName);
    const tool = v.host.querySelector<HTMLElement>('[data-slot="tool-call-trigger"]')!;
    expect(tool.textContent).toContain('plugin_gugu-product_gugu, message_send');
    expect(tool.getAttribute('aria-expanded')).toBe('false');
    expect(tool.closest('[data-row-kind="tool"]')).not.toBeNull();
    runs[0].querySelector<HTMLButtonElement>('[data-collapse-id]')!.click();
    await v.settle();
    expect(v.host.textContent).not.toContain(nativeName);
  });

  it('shows a single pending MCP identity and discloses its arguments independently of old run state', async () => {
    const v = mount([pending]);
    await until('process appears', () => !!v.host.querySelector('[data-conversation-process]'));
    await v.settle();
    const run = v.host.querySelector('[data-slot="tool-run"]');
    expect(run).toBeNull();
    const tool = () => v.host.querySelector<HTMLElement>('[data-slot="tool-call-trigger"]')!;
    expect(tool().textContent).toContain('plugin_gugu-product_gugu, message_send');
    expect(tool().getAttribute('aria-expanded')).toBe('false');
    v.state.viewState.setCollapsed('live:run:send', true);
    await v.settle();
    expect(v.host.textContent).not.toContain(nativeName);
    expect(tool().getAttribute('aria-expanded')).toBe('false');
    expect(v.host.querySelector('[data-slot="tool-call-request"]')).toBeNull();
    tool().click();
    await until('the pending MCP arguments open', () => v.host.querySelector('[data-slot="tool-call-request"]')?.textContent?.includes('Status update.') === true);
    expect(tool().getAttribute('aria-expanded')).toBe('true');
  });

  // #2587: the completion is a step of the live process (one phrase in it), and opens down to the same row.
  it.each(['completed', 'failed', 'stopped'] as const)('keeps a %s background completion semantic until explicitly opened', async outcome => {
    const command = 'cd /tmp && (which pnpm >/dev/null && pnpm --version)';
    const v = mount([{ kind: 'background-command-done-tool-call', id: 'completed-command', seq: 1,
      toolCallId: 'done', launchToolCallId: 'launch', title: command, name: command, status: 'done', outcome, summary: 'Original completion details' }]);
    const row = () => v.host.querySelector<HTMLElement>('[data-conversation-step="completed-command"]');
    // A failed one says so in the summary too: inside the process line it has no row of its own to say it (#2587).
    const phrase = `1 background command ${outcome === 'completed' ? 'finished' : outcome}`;
    await until('the live process says the completion', () => v.host.querySelector('[data-slot="conversation-process-steps"]')?.textContent?.includes(phrase) === true);
    expect(row()).toBeNull();
    expect(v.host.textContent).not.toContain(command);
    v.state.viewState.setCollapsed('live:run:completed-command', true);
    await until('the completion row opens inside the process', () => !!row());
    expect(row()!.closest('[data-slot="conversation-process-steps"]')).not.toBeNull();
    const button = () => row()!.querySelector<HTMLButtonElement>('[data-collapse-id]')!;
    expect(row()!.textContent).toBe(`background command ${outcome === 'completed' ? 'finished' : outcome}›`);
    expect(row()!.textContent).not.toContain(command);
    expect(button().getAttribute('aria-expanded')).toBe('false');
    button().click();
    await until('completion command can be read', () => row()!.textContent!.includes(command));
    expect(row()!.textContent).toContain('Original completion details');
    expect(button().getAttribute('aria-expanded')).toBe('true');
    button().click();
    await until('completion command closes', () => !row()!.textContent!.includes(command));
    expect(row()!.getBoundingClientRect().height).toBe(32);
  });
});
