/** @jsxImportSource solid-js */
import { afterEach, expect, it } from 'vitest';
import { cdp, page } from 'vitest/browser';
import { createChatContext } from '../chat-context';
import { createChatState } from '../state/chat-state';
import { createChatView } from '../chat-view';
import type { TranscriptTurn } from '../model';
import { defaultChatTranslator } from '../localization';
import { zhCNMessages } from '../../../../apps/desktop/src/session/renderer/localization/messages';
import { until, untilStable } from '../../../../tests/support/awaitCondition';

const cleanup: (() => void)[] = [];
afterEach(() => { while (cleanup.length) cleanup.pop()?.(); });
const capturePhase = import.meta.env.VITE_COMMENTARY_CAPTURE_PHASE;
// Replays the message/tool order and timestamps from the reported native turn.
const turn: TranscriptTurn = { id: 'weather', seq: 1, initiator: 'user',
  startedAt: Date.parse('2026-11-08T03:21:04.457Z'), endedAt: Date.parse('2026-11-08T03:21:24.912Z'), outcome: { kind: 'done' }, items: [
    { kind: 'message', id: 'input', seq: 0, role: 'user', text: '什么情况，你搜索南京天津天气，按顺序搜索 搜索完立刻返回' },
    { kind: 'message', id: 'commentary', seq: 1, role: 'assistant', text: '我按南京、天津的顺序搜索，查完立即返回。', at: Date.parse('2026-11-08T03:21:06.963Z') },
    { kind: 'execute-tool-call', id: 'nanjing', seq: 2, toolCallId: 'nanjing', title: '搜索南京天气', status: 'done', command: '搜索南京天气',
      at: Date.parse('2026-11-08T03:21:07.573Z'), outputText: '南京：多云，8～16℃。' },
    { kind: 'execute-tool-call', id: 'tianjin', seq: 3, toolCallId: 'tianjin', title: '搜索天津天气', status: 'done', command: '搜索天津天气',
      at: Date.parse('2026-11-08T03:21:11.415Z'), outputText: '天津：晴，0～6℃。' },
    { kind: 'message', id: 'final', seq: 4, role: 'assistant', at: Date.parse('2026-11-08T03:21:24.912Z'),
      text: '搜索结果：\n\n- **南京**：多云，约 **8～16℃**。\n- **天津**：晴，约 **0～6℃**。\n\n以上为搜索到的当日天气预报。' },
  ] };

it.each(['light', 'dark'])('keeps ordinary progress in the process and only the final answer in a body bubble (%s)', async appearance => {
  await page.viewport(390, 800);
  await cdp().send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 0, y: 0 });
  const context = createChatContext({ locale: () => 'zh-CN',
    translator: (key, values) => {
      const text = zhCNMessages[key as keyof typeof zhCNMessages];
      return text ? text.replace(/\{(\w+)\}/g, (_, name: string) => String(values?.[name] ?? `{${name}}`)) : defaultChatTranslator(key, values);
    }, layout: { preset: 'double', agentConversation: true, userGutter: 0 } });
  const state = createChatState(context);
  state.transcript.history.seed([turn]);
  const host = document.body.appendChild(document.createElement('div'));
  host.className = appearance === 'dark' ? 'emdark' : 'emlight';
  host.style.cssText = 'position:fixed;left:0;top:0;width:390px;height:800px;background:var(--chat-bg)';
  const view = createChatView({ context, state, parent: host, pinUserMessages: false,
    commands: { conversationAgentName: () => 'hello' } });
  cleanup.push(() => { view.dispose(); state.dispose(); context.dispose(); host.remove(); });
  view.scrollToTop();
  await until('the final body mounts', () => !!host.querySelector('[data-user-card="final"]'));
  await untilStable('the completed turn settles', () => host.querySelector('[data-chat-canvas]')?.getBoundingClientRect().height);
  if (capturePhase) {
    const label = host.appendChild(document.createElement('div'));
    label.textContent = `${capturePhase === 'before' ? '改前' : '改后'} · 测试环境渲染\n未经真机验证，原因：无真机`;
    label.style.cssText = 'position:absolute;bottom:8px;left:12px;white-space:pre-line;font:11px/18px sans-serif;color:#888;pointer-events:none';
    await page.screenshot({ element: host, path: `__screenshots__/commentary-${capturePhase}-390-${appearance}.png` });
    label.remove();
  }
  expect(host.querySelectorAll('[data-conversation-part="body"]')).toHaveLength(1);
  expect(host.querySelector('[data-user-card="commentary"]')).toBeNull();
  expect(host.querySelectorAll('[data-conversation-part="head"]')).toHaveLength(1);
  host.querySelector<HTMLButtonElement>('[data-conversation-process]')!.click();
  await until('the original progress text opens inside the process', () => !!host.querySelector('[data-conversation-narration="commentary"]'));
  expect(host.querySelector('[data-conversation-narration="commentary"]')?.textContent).toContain('我按南京、天津的顺序搜索');
  view.scrollToItem('final');
  await until('the final answer remains reachable after process expansion', () => !!host.querySelector('[data-user-card="final"]'));
});
