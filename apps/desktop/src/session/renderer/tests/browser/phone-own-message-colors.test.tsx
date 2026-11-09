import { createChatContext, createChatState, type ChatMessage } from '@gugu/session-chat-ui';
import { afterEach, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import { SessionUiTheme } from '@/components/sessionpage/SessionUiTheme';
import { AgentConversationView } from '@renderer/lib/chat/agent-conversation-view';
import { workspaceFileMentionProvider } from '@renderer/lib/chat/workspace-file-mention-provider';
import { until } from '../../../../../../../tests/support/awaitCondition';
import { createReactHarness } from '../../../../../../../tests/support/testHarness';
import '@/styles/tokens.css';
import '@renderer/index.css';
import '@/mobile/phone-look.css';
import '@/components/assistant/assistant-task-chat.css';

const cleanups: (() => void)[] = [];
const oldTheme = document.documentElement.dataset.theme;
const oldClasses = document.documentElement.className;
afterEach(() => {
  cleanups.splice(0).reverse().forEach(cleanup => cleanup());
  document.documentElement.className = oldClasses;
  if (oldTheme) document.documentElement.dataset.theme = oldTheme;
  else delete document.documentElement.dataset.theme;
});

it.each(['light', 'dark'].flatMap(theme => ['conversation', 'task'].map(surface => ({ theme: theme as 'light' | 'dark', surface }))))('keeps a phone $surface own message readable inside the scoped $theme session theme', async ({ theme, surface }) => {
  await page.viewport(390, 780);
  document.documentElement.dataset.theme = theme;
  document.documentElement.classList.remove('emlight', 'emdark');
  const host = document.body.appendChild(document.createElement('div'));
  host.style.cssText = 'position:fixed;inset:0;width:390px;height:780px;background:var(--bg);color:var(--text-primary);font:14px sans-serif';
  const label = host.appendChild(document.createElement('div'));
  label.textContent = `测试环境渲染，未经真机验证，原因：无真机\n${import.meta.env.VITE_OWNER_CAPTURE_SHA ?? 'regression test'}`;
  label.style.cssText = 'height:64px;overflow-wrap:anywhere;padding:8px;box-sizing:border-box;font-size:var(--font-caption)';
  const shell = host.appendChild(document.createElement('div'));
  shell.setAttribute('data-phone-shell', '');
  shell.setAttribute('data-ta-scope', '');
  shell.style.cssText = 'display:flex;height:680px';
  const reference = host.appendChild(document.createElement('span'));
  reference.style.color = 'var(--text-primary)';
  reference.textContent = '正常本人正文颜色';
  const context = createChatContext({ locale: () => 'zh-CN', mentionProvider: workspaceFileMentionProvider,
    layout: { preset: 'double', agentConversation: true, userGutter: 0 } });
  const state = createChatState(context);
  const message = { kind: 'message', id: 'own-email', seq: 0, role: 'user',
    text: '请检查这个构造邮箱：someone@example.com', sentTo: { kind: 'session', count: 1 } } satisfies ChatMessage;
  state.transcript.history.seed([{ id: 'owner-input', seq: 1, initiator: 'user', outcome: { kind: 'done' }, items: [message] }]);
  const mount = surface === 'task' ? shell.appendChild(document.createElement('section')) : shell;
  if (surface === 'task') mount.className = 'assistant-task-chat-window';
  const harness = createReactHarness();
  harness.container.style.display = 'contents';
  mount.append(harness.container);
  cleanups.push(() => { harness.cleanup(); state.dispose(); context.dispose(); host.remove(); });
  await harness.render(<SessionUiTheme theme={theme}><AgentConversationView context={context} state={state} /></SessionUiTheme>);
  await until('actual message body and destination render', () => !!shell.querySelector('[data-user-card] .gg-md p') && !!shell.querySelector('[data-slot="sent-to"]'));
  const card = shell.querySelector<HTMLElement>('[data-user-card]')!;
  const text = card.querySelector<HTMLElement>('.gg-md p')!;
  const phase = import.meta.env.VITE_OWNER_CAPTURE_PHASE;
  if (phase) await page.screenshot({ element: host, path: `__screenshots__/owner-2245-${phase}-${surface}-${theme}.png` });
  expect(document.documentElement.classList.contains(`em${theme}`)).toBe(false);
  expect(getComputedStyle(shell).getPropertyValue('--foreground')).toBe('');
  expect(getComputedStyle(text).color).toBe(getComputedStyle(reference).color);
  expect(getComputedStyle(text).opacity).toBe('1');
  expect(getComputedStyle(card).colorScheme).toBe(theme);
  expect(card.querySelector('.gg-md-mention')).toBeNull();
  expect(card.querySelector('a[href="mailto:someone@example.com"]')?.textContent).toBe('someone@example.com');
});
