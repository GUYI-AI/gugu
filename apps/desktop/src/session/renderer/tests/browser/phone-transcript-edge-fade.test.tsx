import { createChatContext, createChatState } from '@gugu/session-chat-ui';
import { afterEach, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import { SessionUiTheme } from '@/components/sessionpage/SessionUiTheme';
import { AgentConversationView } from '@renderer/lib/chat/agent-conversation-view';
import { until } from '../../../../../../../tests/support/awaitCondition';
import { createReactHarness } from '../../../../../../../tests/support/testHarness';
import '@/styles/tokens.css';
import '@renderer/index.css';
import '@/mobile/phone-shell.css';
import '@/mobile/phone-look.css';

// owner 11-09 (phone Beta, dark): a bright band under the title bar and above the composer. The transcript's
// edge fades are drawn in --chat-bg; on the phone the transcript has no surface of its own and sits on the
// shell's page color, so a --chat-bg that differs from it paints a lighter strip instead of a fade.
const cleanups: (() => void)[] = [];
const oldTheme = document.documentElement.dataset.theme;
afterEach(() => {
  cleanups.splice(0).reverse().forEach(cleanup => cleanup());
  if (oldTheme) document.documentElement.dataset.theme = oldTheme;
  else delete document.documentElement.dataset.theme;
});

const firstColor = (gradient: string) => gradient.match(/(rgba?\([^)]*\)|color\([^)]*\))/)?.[1];

it.each(['dark', 'light'] as const)('%s: phone transcript edge fades start from the page color behind them', async theme => {
  await page.viewport(390, 780);
  document.documentElement.dataset.theme = theme;
  const shell = document.body.appendChild(document.createElement('div'));
  shell.setAttribute('data-phone-shell', '');
  shell.setAttribute('data-ta-scope', '');
  shell.style.cssText = 'position:fixed;inset:0;display:flex;background:var(--ta-panel-bg)';
  const context = createChatContext({ locale: () => 'zh-CN', layout: { preset: 'double', agentConversation: true, userGutter: 0 } });
  const state = createChatState(context);
  state.transcript.history.seed([{ id: 'turn', seq: 1, initiator: 'user', outcome: { kind: 'done' }, items: [
    { kind: 'message', id: 'reply', seq: 0, role: 'assistant', text: '一条回复' }] }]);
  const harness = createReactHarness();
  harness.container.style.display = 'contents';
  shell.append(harness.container);
  cleanups.push(() => { harness.cleanup(); state.dispose(); context.dispose(); shell.remove(); });
  await harness.render(<SessionUiTheme theme={theme}><AgentConversationView context={context} state={state} /></SessionUiTheme>);
  await until('the transcript renders', () => !!shell.querySelector('[data-chat-root] [data-item-id="reply"]'));
  const root = shell.querySelector<HTMLElement>('[data-chat-root]')!;
  const page_ = getComputedStyle(shell).backgroundColor;
  const probe = root.appendChild(document.createElement('i'));
  probe.style.backgroundColor = 'var(--chat-bg)';
  expect(getComputedStyle(probe).backgroundColor, 'the chat page color is the phone page color').toBe(page_);
  expect(firstColor(getComputedStyle(root, '::before').backgroundImage), 'the top fade starts from the page color').toBe(page_);
});
