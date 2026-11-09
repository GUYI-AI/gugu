/** @jsxImportSource solid-js */
import { afterEach, expect, it } from 'vitest';
import { cdp, page } from 'vitest/browser';
import { createChatContext } from '../chat-context';
import { createChatState } from '../state/chat-state';
import { createChatView } from '../chat-view';
import type { TranscriptTurn } from '../model';
import { zhCNMessages } from '../../../../apps/desktop/src/session/renderer/localization/messages';
import { defaultChatTranslator } from '../localization';
import { until, untilStable } from '../../../../tests/support/awaitCondition';
import { plainMessageBody } from './fixtures/plain-message-body';

const peer = 'user:11111111-1111-4111-8111-111111111111';
const cleanup: (() => void)[] = [];
afterEach(() => { while (cleanup.length) cleanup.pop()?.(); });
const quiet = (id: string): TranscriptTurn => ({ id, seq: 0, initiator: 'agent',
  startedAt: Date.parse('2026-11-07T12:39:00Z'), endedAt: Date.parse('2026-11-07T12:39:10Z'), outcome: { kind: 'done' },
  items: [{ kind: 'message', id: `${id}-quiet`, seq: 2, role: 'assistant', text: '[NO_REPLY]' }] });
const incoming = (id: string): TranscriptTurn => ({ ...quiet(id), items: [
  { kind: 'message', id: `${id}-input`, seq: 0, role: 'user', text:
    `<gugu_delivery route="chat" from="桌面主管（Claude，d22）" from_id="${peer}" from_type="agent" chat="group" chat_kind="group" msg="msg:${id}"><![CDATA[正在核对接入、审查和实测结果，23:00 前汇报。]]></gugu_delivery>` },
  ...quiet(id).items,
] });
const send = (id: string, advisory: boolean): TranscriptTurn => ({ ...quiet(id), items: [
  { kind: 'mcp-tool-call', id: `${id}-send`, toolCallId: `${id}-send`, seq: 1, title: 'Send',
    tool: 'message_send', server: 'plugin_gugu-product_gugu', status: 'done',
    rawInput: JSON.stringify({ chat_id: 'group', to_user_ids: [peer], reply_to_message_id: 'msg:source',
      text: '@桌面主管（Claude，d22） 可以。23:00 给我定论。接入、审查、实测都过了就带，没过就等下一班。' }),
    outputText: `replied (id=msg:6417511d-8f36-4cbc-8cbb-81ce9f97df73)${advisory ? '\n提醒:你在这个群里 1 小时内已发 34 条,其间没有人发言。不急的话先停一下,等有人说话或 @ 你再继续。' : ''}` },
  ...quiet(id).items,
] });

it.each([
  { width: 390, appearance: 'light' }, { width: 390, appearance: 'dark' },
  { width: 1024, appearance: 'light' }, { width: 1024, appearance: 'dark' },
])('replays advisory sends and silent turns in the shared renderer ($width px/$appearance)', async ({ width, appearance }) => {
  await page.viewport(width, 850);
  await cdp().send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 0, y: 0 });
  const context = createChatContext({ locale: () => 'zh-CN',
    translator: (key, values) => {
      const text = zhCNMessages[key as keyof typeof zhCNMessages];
      return text ? text.replace(/\{(\w+)\}/g, (_, name: string) => String(values?.[name] ?? `{${name}}`)) : defaultChatTranslator(key, values);
    },
    layout: { preset: 'double', agentConversation: true, userGutter: 0 },
    actor: id => id === peer ? { id, type: 'agent', name: '桌面主管（Claude，d22）' } : null,
    selfIdentity: () => ({ userId: 'owner', displayName: 'yangchichi', guguNumber: null }),
    chatName: () => '咕咕开发者们', chatKind: () => 'group' });
  const state = createChatState(context);
  const records = [
    { ...quiet('report'), items: [{ kind: 'message' as const, id: 'report-text', seq: 0, role: 'assistant' as const,
      text: '进度已整理，接下来核对桌面与手机的同一套渲染。' }] },
    incoming('one'), quiet('between'), send('two', true), incoming('three'), send('four', false),
    { ...quiet('owner'), initiator: 'user' as const, items: [{ kind: 'message' as const, id: 'owner-input', seq: 0, role: 'user' as const,
      text: '手机端这个展开折叠还是乱的。发给 Agent 的消息应该并进往来行，选择不回话的轮不要再占一行。' },
      { kind: 'message' as const, id: 'acknowledgement', seq: 1, role: 'assistant' as const, text: '收到，继续核对同一段历史。' }] },
  ];
  state.transcript.history.seed(records.map((turn, seq) => ({ ...turn, seq })));
  const host = document.body.appendChild(document.createElement('div'));
  host.className = appearance === 'dark' ? 'emdark' : 'emlight';
  host.style.cssText = `position:fixed;left:0;top:0;width:${width}px;height:800px;background:var(--chat-bg)`;
  const view = createChatView({ context, state, parent: host, pinUserMessages: width > 390,
    commands: { conversationAgentName: () => '研发主管（Claude）', onMessageBodyMount: plainMessageBody } });
  cleanup.push(() => { view.dispose(); state.dispose(); context.dispose(); host.remove(); });
  view.scrollToTop();
  await until('owner message mounted', () => !!host.querySelector('[data-agent-conversation-message="owner-input"]'));
  await untilStable('replay geometry settles', () => [...host.querySelectorAll<HTMLElement>('[data-index]')]
    .map(row => [row.getBoundingClientRect().top, row.getBoundingClientRect().height]));
  expect(getComputedStyle(host).backgroundColor).toBe(appearance === 'dark' ? 'rgb(17, 17, 17)' : 'rgb(252, 252, 252)');
  await page.screenshot({ element: host, path: `__screenshots__/activity-replay-${width}-${appearance}-closed.png` });
  const headers = host.querySelectorAll('[data-agent-activity]');
  expect(headers).toHaveLength(1);
  expect(host.textContent).not.toContain('这一段选择不回话');
  expect(host.textContent).not.toContain('调用了 1 个 MCP 工具');
  headers[0].querySelector<HTMLButtonElement>('[data-collapse-id]')!.click();
  await until('original sent text restored', () => !!host.textContent?.includes('23:00 给我定论'));
  await untilStable('opened replay geometry settles', () => host.querySelector('[data-chat-canvas]')?.getBoundingClientRect().height);
  await page.screenshot({ element: host, path: `__screenshots__/activity-replay-${width}-${appearance}-open.png` });
  expect(host.textContent).not.toContain('调用了 1 个 MCP 工具');
});
