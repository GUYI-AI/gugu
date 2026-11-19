import { act, useSyncExternalStore } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import '@/styles/tokens.css';
import '@renderer/index.css';
import { DesktopLiveWindowConversation } from '../../features/live-window/DesktopLiveWindowConversation';
import { LiveWindowModel } from '../../features/live-window/model';
import { AgentConversationView } from '@renderer/lib/chat/agent-conversation-view';
import { loadChatUi } from '@renderer/lib/chat/chat-transcript';

const state = vi.hoisted(() => ({ model: null as unknown as LiveWindowModel }));
vi.mock('@renderer/lib/machine-routing', async (importOriginal) => ({ ...await importOriginal<object>(), machineRegistry: { machineOf: () => null } }));
vi.mock('../../features/sessions/stores/session-agent-bindings', () => ({ sessionAgentBindings: { bindingFor: () => ({ agentUserId: 'agent' }) } }));
vi.mock('../../features/remote-hosts/remote-hosts-store', () => ({ remoteHostsStore: { connectionState: () => 'connected' } }));
vi.mock('../../features/live-window/desktop-context', () => ({ bindDesktopLiveWindowActivity: () => {} }));
vi.mock('../../features/live-window/desktop-transport', () => ({ desktopLiveWindowTransport: () => ({}) }));
vi.mock('../../features/live-window/use-live-window-conversation', () => ({
  liveWindowConversationKey: () => 'chat',
  useLiveWindowConversation: () => {
    const snapshot = useSyncExternalStore(state.model.subscribe, state.model.getSnapshot);
    return { ...snapshot, sources: snapshot.sources.map(source => ({ ...source, picture: <div>Live picture</div> })),
      conversation: state.model, dispatch: state.model.dispatch.bind(state.model) };
  },
}));
vi.mock('../../features/tabs/pane-context', () => ({ usePaneContext: () => ({ paneId: 'pane', pane: {
  ctx: { projectId: 'project' },
  entries: new Map([['chat', { tabId: 'chat', kind: 'acp-chat', state: { sessionId: 'task' } }]]),
  resolvedTabs: [{ tabId: 'chat', kind: 'acp-chat', isActive: true }],
} }) }));
vi.mock('../../features/tabs/pane-layout-context', () => ({ usePaneLayoutContext: () => ({}) }));

let root: Root | undefined, host: HTMLDivElement | undefined;
let dispose = () => {};
afterEach(() => { act(() => root?.unmount()); dispose(); host?.remove(); root = undefined; host = undefined; });

it.each(['floating', 'enlarged'] as const)('paints the %s desktop window above a real long user message', async mode => {
  await page.viewport(1280, 960);
  state.model = new LiveWindowModel('desktop');
  const context = { conversationId: 'task', deviceId: 'local', sessionId: 'task', agentId: 'agent', privateAgentChat: true, shown: true };
  state.model.activate(context);
  state.model.observe(context, [{ ...context, id: 'screen', kind: 'browser', title: 'Browser', status: 'operating', size: { width: 1280, height: 900 } }]);
  if (mode === 'enlarged') state.model.dispatch({ type: 'enlarge' });
  const { createChatContext, createChatState } = await loadChatUi();
  const chatContext = createChatContext({ locale: () => 'en-US', layout: { preset: 'double', userGutter: 0 } });
  const chat = createChatState(chatContext);
  chat.transcript.history.seed([{ id: 'turn', seq: 1, initiator: 'user', outcome: { kind: 'done' }, items: [
    { kind: 'message', id: 'long-input', seq: 0, role: 'user', text: 'A long user message that spans the live picture.\n\n'.repeat(22) },
  ] }]);
  dispose = () => { chat.dispose(); chatContext.dispose(); };
  host = document.body.appendChild(document.createElement('div'));
  host.className = 'gugu-skin emlight'; host.style.cssText = 'position:relative;width:1000px;height:800px';
  root = createRoot(host);
  await act(async () => root!.render(<DesktopLiveWindowConversation kind="acp-chat">
    <AgentConversationView context={chatContext} state={chat} style={{ position: 'absolute', inset: 0 }} />
  </DesktopLiveWindowConversation>));
  await vi.waitFor(() => {
    const window = host!.querySelector<HTMLElement>('[data-live-window]')!;
    const message = host!.querySelector<HTMLElement>('[data-user-card]')!;
    expect(window).not.toBeNull(); expect(message).not.toBeNull();
    const a = window.getBoundingClientRect(), b = message.getBoundingClientRect();
    const left = Math.max(a.left, b.left), right = Math.min(a.right, b.right);
    const top = Math.max(a.top, b.top), bottom = Math.min(a.bottom, b.bottom, 800);
    expect(right - left).toBeGreaterThan(20); expect(bottom - top).toBeGreaterThan(20);
    expect(document.elementFromPoint((left + right) / 2, (top + bottom) / 2)?.closest('[data-live-window]')).toBe(window);
  });
  if (import.meta.env.VITE_OWNER_CAPTURE_PHASE) await page.screenshot({ element: host,
    path: `__screenshots__/live-window-3081-${mode}-${import.meta.env.VITE_OWNER_CAPTURE_PHASE}.png` });
});
