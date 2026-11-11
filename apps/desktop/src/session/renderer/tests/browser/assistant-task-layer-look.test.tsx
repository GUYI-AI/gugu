/**
 * Owner 11-12 (a task opened from the assistant's chat, drawn over the App's panel): 「颜色不对,输入框也不对」. The task is a
 * layer of that panel (AppHostLayerHost → AssistantTaskChatWindow appPanel), so, judged here with real Chromium and real CSS
 * at the panel's size:
 *   1. the panel's surface shows through (no page background of its own);
 *   2. its header is the panel's top row: as high as it (--ta-h-top), its back the panel's round back, the face, name and
 *      status beside it, none of them under the collapse in the corner, the title not clipped;
 *   3. no view switcher (对话 ▾ / the session's Apps);
 *   4. the assistant chat's composer: its placeholder, 「+」, send — no permission, model or effort control.
 * The same page anywhere else (no appPanel) keeps its switcher and its model and permission controls.
 */
import { afterEach, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import type { TranscriptTurn } from '@gugu/session-core/acp/client';
import type { SessionpageSessionSummary } from '@gugu/session-core/session-record/contract';
import { AssistantTaskChatWindow } from '@/components/assistant/AssistantTaskChatWindow';
import { SessionTimelinePage } from '@/mobile/agent-watch/SessionTimelinePage';
import { emptyAgentWatchTimeline, type AgentWatchTimeline } from '@/mobile/agent-watch/agent-watch-store';
import { DevicesContext } from '@/store/devicesContext';
import { i18n } from '@/i18n';
import { composerModelOptions } from '@renderer/features/sessions/session-config/platform-model-options';
import { modelProviderIcon } from '@renderer/features/sessions/session-config/model-provider-icon';
import { createReactHarness, device, renderWithAppProviders } from '../../../../../../../tests/support/testHarness';
import { until } from '../../../../../../../tests/support/awaitCondition';
import '@/i18n/registerMessagingCatalog';
import '@/i18n/registerAssistantCatalog';
import '@gugu/session-ui/styles/global';
import '@gugu/session-ui/theme/theme.css';
import '@gugu/session-ui/theme/semantic.css';
import '@gugu/session-ui/styles/base.css';
import '@/styles/tokens.css';
import '@renderer/index.css';
import '@renderer/features/assistant/assistant-today.css';

const fixture = vi.hoisted(() => ({ timeline: null as unknown, summary: null as unknown }));
const SESSION = 'task-session';
const DEVICE = device('mbp', [], { is_current_device: true } as never);
const SENT_AT = Date.now() - 60_000;
// Enough turns to run under the header and the composer: the fades there are the panel's, not white strips.
const TIMELINE: AgentWatchTimeline = { ...emptyAgentWatchTimeline(), turns: Array.from({ length: 5 }, (_, index) => ({
  id: `${SESSION}:turn:${index}`, seq: index, initiator: 'user', startedAt: SENT_AT + index * 5000, endedAt: SENT_AT + index * 5000 + 3000, outcome: { kind: 'done' },
  items: [
    { kind: 'message', role: 'user', id: `u${index}`, seq: 0, text: index === 4 ? '在测试项目里写一个 hello.md' : `第 ${index + 1} 步:看一下测试项目里有哪些文件` },
    { kind: 'message', role: 'assistant', id: `a${index}`, seq: 1, text: index === 4
      ? '我在项目文件夹里新建了 `hello.md`,内容是一句中文问候加当前日期,没有做其他改动。我已把完成情况汇报给委派方,对方已收到。'
      : '测试项目里现在有 `README.md`、`src/` 和 `package.json` 三项。`src/` 里是一个入口文件和两个工具函数,没有测试目录。要不要我先补一个最小的测试,再接着写说明?' },
  ],
} as TranscriptTurn)) };

vi.mock('@gugu/core/cloud/config', async (original) => ({ ...(await original<object>()), getSupabaseUrl: () => 'http://supabase.test.local', getSupabaseAnonKey: () => 'test-anon-key' }));
vi.mock('@renderer/features/settings/use-app-settings-key', () => ({ useAppSettingsKey: () => ({ value: { chatView: 'double' } }) }));
vi.mock('@/mobile/agent-watch/sessionpage-rpc', async (original) => ({ ...(await original<object>()), fetchSessionOptions: vi.fn(() => new Promise(() => {})), machineRpc: () => ({ sessions: { getStoredHistory: vi.fn() } }) }));
vi.mock('@/mobile/agent-watch/useSessionLifeView', () => ({ useSessionLifeView: () => ({ view: null, error: null, current: () => null }) }));
vi.mock('@/mobile/agent-watch/useSessionRestart', () => ({ useSessionRestart: () => ({ canStartFresh: false, busy: false, refreshing: false, pendingPrompt: null, error: null, startFresh: async () => undefined, retry: null }) }));
vi.mock('@/mobile/agent-watch/useTimelineFailureNotice', () => ({ useTimelineFailureNotice: () => undefined }));
vi.mock('@/mobile/agent-watch/useAgentWatchSession', async (original) => ({
  ...(await original<object>()),
  useAgentWatchSession: () => ({
    timeline: fixture.timeline, phase: 'ready', error: null, actionError: null, dismissActionError() {}, waitingForRecord: false, reload() {},
    loadOlder: async () => undefined, loadToolImage: async () => undefined, pendingSends: [], respond: async () => ({ ok: true }), sending: false,
    respondingItemId: null, cancel() {}, cancelling: false, link: 'ok', errorCode: null,
  }),
}));
// The view switcher (对话 ▾ and the session's App tabs), as offered when there are App tabs: the page decides where it goes.
vi.mock('@/mobile/agent-watch/SessionAppMenu', () => ({ SessionAppMenu: () => <button type="button" data-testid="session-app-menu">对话</button> }));
vi.mock('@/session/shared/remote-sessions/session-directory', async (original) => ({
  ...(await original<object>()),
  listedSession: () => ({ row: { deviceId: 'mbp', session: fixture.summary } }),
}));
// A session that offers a model, an effort and a permission mode: the controls the panel's composer must not show.
vi.mock('@/components/chat/useConversationOptions', () => ({
  useConversationOptions: () => {
    const models = composerModelOptions({}, [{ id: 'sonnet', displayName: 'Sonnet 5.5', protocol: 'anthropic-messages', creditMultiplier: 1, contextWindow: 200000, reasoningEfforts: null }], { ownTierLabel: 'Claude', icon: modelProviderIcon });
    return {
      props: {
        modelOptions: models, selectedModel: Object.keys(models!)[0],
        effortOptions: { high: { name: 'Xhigh' } }, selectedEffort: 'high',
        permissionModeOptions: { full: { name: '完全访问', destructive: true } }, selectedPermissionMode: 'full',
      },
      confirmation: null,
      steers: false,
    };
  },
}));

const SUMMARY = {
  conversationId: SESSION, projectId: 'project', title: '能力测试:写一份说明', runtime: 'codex', harness: 'claude-code',
  agentStatus: 'idle', status: { status: 'idle', detail: null }, agent: { userId: 'agent-1' },
} as unknown as SessionpageSessionSummary;
fixture.timeline = TIMELINE;
fixture.summary = SUMMARY;

let harness: ReturnType<typeof createReactHarness> | undefined;
afterEach(() => {
  vi.restoreAllMocks();
  harness?.cleanup();
  harness = undefined;
  document.body.replaceChildren();
  delete document.documentElement.dataset.theme;
});

const PANEL = { width: 600, height: 860 };
const box = (element: Element | null) => element!.getBoundingClientRect();

async function mountPanelLayer(theme: 'light' | 'dark') {
  await i18n.changeLanguage('zh-CN');
  await page.viewport(1280, 900);
  document.documentElement.dataset.theme = theme;
  harness = createReactHarness();
  harness.container.style.cssText = 'position:fixed;inset:0;display:flex;padding:20px;';
  // The App's surface as app-conversation-frame.tsx and HostTaskLayer draw it: chat column, panel, the layer's cell and the
  // panel's collapse in its corner.
  await renderWithAppProviders(harness, (
    <DevicesContext.Provider value={{ ...DEVICES, devices: [DEVICE] }}>
      <div className="ta-app" data-panel="open" style={{ width: 1240, height: PANEL.height, display: 'flex' }}>
        <div className="ta-chat-col" style={{ flex: 1 }} />
        <section className="ta-panel" data-testid="app-conversation-panel" style={{ flex: `0 0 ${PANEL.width}px` }}>
          <div className="ta-task-chat-slot" data-testid="app-work-chat">
            <AssistantTaskChatWindow agent={{ id: 'agent-1', display_name: '能力测试:写一份说明', avatar: null }} task={{ deviceId: 'mbp', sessionId: SESSION } as never} onClose={() => undefined} appPanel />
          </div>
          <button type="button" className="ta-circle ta-task-panel-collapse" aria-label="收起" data-testid="app-work-panel-collapse">▢</button>
        </section>
      </div>
    </DevicesContext.Provider>
  ), { contacts: {} });
  await until('the task page in the panel', () => !!harness!.container.querySelector('[data-testid="agent-watch-timeline-page"] [data-slot="composer-input"]'));
  await new Promise((resolve) => setTimeout(resolve, 500));
}

const DEVICES = {
  devices: [], loading: false, error: null, refresh: async () => {}, rename: async () => {}, remove: async () => {},
  listBoundAgents: async () => [], cloudComputer: { available: false, snapshot: null, loadError: null, wakeRefused: null },
} as unknown as React.ContextType<typeof DevicesContext>;

/** Pseudo-elements in `root` that paint something: the transcript's edge fades are drawn this way. */
const paintedPseudo = (root: Element) => [...root.querySelectorAll('*')].flatMap((element) => ['::before', '::after'].filter((pseudo) => {
  const style = getComputedStyle(element, pseudo);
  return style.content !== 'none' && (style.backgroundImage !== 'none' || style.backgroundColor !== 'rgba(0, 0, 0, 0)');
}));

it.each(['light', 'dark'] as const)('over the App panel the task reads as part of the panel: its surface, its top row, the chat composer (%s)', async (theme) => {
  await mountPanelLayer(theme);
  const host = harness!.container;
  const panel = host.querySelector('[data-testid="app-conversation-panel"]')!;
  const window = host.querySelector('[data-testid="assistant-task-chat-window"]')!;
  const screen = host.querySelector('[data-testid="agent-watch-timeline-page"]')!;
  expect(window.getAttribute('data-app-panel')).toBe('true');
  expect(screen.getAttribute('data-panel-layer')).toBe('true');

  // 1. The panel's gradient shows through: no page color of the task's own, no white fades painted over the gradient;
  //    a pinned message's strip is the gradient where it sticks.
  expect(getComputedStyle(panel).backgroundImage).toContain('linear-gradient');
  expect(getComputedStyle(screen).backgroundColor).toBe('rgba(0, 0, 0, 0)');
  expect(paintedPseudo(screen)).toEqual([]);
  expect(getComputedStyle(host.querySelector('[data-chat-scroll]')!).maskImage).toContain('linear-gradient');
  for (const strip of host.querySelectorAll('[data-chat-pin-backdrop]')) expect(getComputedStyle(strip).backgroundImage).toContain('linear-gradient');

  // 2. The header is the panel's top row: its height, its 16px edge, the round back centred with the collapse, then the
  //    face, the name and the status, all clear of the collapse.
  const header = host.querySelector('[data-testid="agent-watch-hero"]')!;
  const collapse = host.querySelector('[data-testid="app-work-panel-collapse"]')!;
  const back = header.querySelector('.gg-aw-panel-back')!;
  const avatar = header.querySelector('.gg-aw-title-avatar')!;
  const title = header.querySelector('.gg-pane-heading-title')!;
  expect(box(header).top).toBeCloseTo(box(panel).top + 1, 0);
  expect(box(header).height).toBe(52);
  // The panel's round back, as its own pages draw it.
  const circle = getComputedStyle(back);
  expect(circle.backgroundColor).not.toBe('rgba(0, 0, 0, 0)');
  expect(circle.boxShadow).not.toBe('none');
  expect(box(back).width).toBe(32);
  expect(box(back).height).toBe(32);
  expect(box(back).left - box(panel).left - 1).toBeCloseTo(16, 0);
  const middle = (element: Element) => box(element).top + box(element).height / 2;
  expect(Math.abs(middle(back) - middle(collapse))).toBeLessThanOrEqual(1);
  expect(box(avatar).left).toBeGreaterThanOrEqual(box(back).right + 8 - 0.5);
  expect(box(title).left).toBeGreaterThan(box(avatar).right);
  expect(title.textContent).toBe('能力测试:写一份说明');
  expect(title.scrollHeight).toBeLessThanOrEqual(title.clientHeight + 1);
  expect(box(title).top).toBeGreaterThanOrEqual(box(header).top);
  expect(header.querySelector('[data-testid="agent-watch-session-status"]')?.textContent).toBeTruthy();
  for (const item of [back, avatar, title, ...header.querySelectorAll('button')]) {
    expect(box(item).right).toBeLessThanOrEqual(box(collapse).left - 8 + 0.5);
  }

  // 3. No view switcher.
  expect(host.querySelector('[data-testid="session-app-menu"]')).toBeNull();

  // 4. The chat column's composer: its placeholder, 「+」 and send, on the panel's content line; nothing about model, effort,
  //    permission or harness.
  const input = host.querySelector('[data-slot="composer-input"]')!;
  const composer = host.querySelector('[data-slot="composer"]') ?? input.parentElement!;
  expect(input.textContent + (input.querySelector('[data-placeholder]')?.getAttribute('data-placeholder') ?? '')).toContain('和能力测试:写一份说明聊天');
  expect(host.querySelector('[data-testid="composer-model-trigger"]')).toBeNull();
  expect(host.querySelector('[data-composer-locked-agent]')).toBeNull();
  expect(composer.textContent).not.toContain('完全访问');
  expect(composer.textContent).not.toContain('Xhigh');
  expect(host.querySelector('button[aria-label="发送消息"]')).not.toBeNull();
  expect(box(window).bottom - box(host.querySelector('[data-slot="composer-bar"]')).bottom).toBeCloseTo(16, 0);

  await page.screenshot({ path: `__screenshots__/assistant-task-layer-look/panel-layer-${theme}.png` });
});

it('the same task page elsewhere keeps its view switcher and its model and permission controls', async () => {
  await i18n.changeLanguage('zh-CN');
  await page.viewport(600, 860);
  document.documentElement.dataset.theme = 'light';
  harness = createReactHarness();
  harness.container.style.cssText = 'height:860px;width:600px;display:flex;flex-direction:column';
  await renderWithAppProviders(harness, <SessionTimelinePage device={DEVICE} session={SUMMARY} local cleanedRecord onBack={() => undefined} />, { contacts: {} });
  await until('the session page composer', () => !!harness!.container.querySelector('[data-testid="composer-model-trigger"]'));
  const host = harness.container;
  expect(host.querySelector('[data-testid="agent-watch-timeline-page"]')!.hasAttribute('data-panel-layer')).toBe(false);
  expect(host.querySelector('[data-testid="agent-watch-hero"] [data-testid="session-app-menu"]')).not.toBeNull();
  expect(host.querySelector('.gg-aw-panel-back')).toBeNull();
  expect(host.textContent).toContain('完全访问');
  expect(host.querySelector('[data-composer-locked-agent]')).not.toBeNull();
});
