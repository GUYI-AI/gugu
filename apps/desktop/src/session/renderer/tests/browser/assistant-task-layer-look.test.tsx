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
import { SessionTimelinePage } from '@/components/session-watch/SessionTimelinePage';
import { emptyAgentWatchTimeline, type AgentWatchTimeline } from '@/components/session-watch/agent-watch-store';
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
vi.mock('@renderer/features/settings/use-app-settings-key', async () => { const { fakeAppSettings } = await import('../../../../../../../tests/support/appSettingsDouble'); return { useAppSettingsKey: () => fakeAppSettings({ chatView: 'double' }) } });
vi.mock('@/components/session-watch/sessionpage-rpc', async (original) => ({ ...(await original<object>()), fetchSessionOptions: vi.fn(() => new Promise(() => {})), machineRpc: () => ({ sessions: {} }) }));
vi.mock('@/components/session-watch/useSessionLifeView', () => ({ useSessionLifeView: () => ({ view: null, error: null, current: () => null }) }));
vi.mock('@/components/session-watch/useSessionRestart', () => ({ useSessionRestart: () => ({ canStartFresh: false, busy: false, refreshing: false, pendingPrompt: null, error: null, startFresh: async () => undefined, retry: null }) }));
vi.mock('@/components/session-watch/useTimelineFailureNotice', () => ({ useTimelineFailureNotice: () => undefined }));
vi.mock('@/components/session-watch/useAgentWatchSession', async (original) => ({
  ...(await original<object>()),
  useAgentWatchSession: () => ({
    timeline: fixture.timeline, phase: 'ready', error: null, actionError: null, dismissActionError() {}, waitingForRecord: false, reload() {},
    loadOlder: async () => undefined, loadToolImage: async () => undefined, pendingSends: [], respond: async () => ({ ok: true }), sending: false,
    respondingItemId: null, cancel() {}, cancelling: false, link: 'ok', errorCode: null,
  }),
}));
// The view switcher (对话 ▾ and the session's App tabs), as offered when there are App tabs: the page decides where it goes.
vi.mock('@/components/session-watch/SessionAppMenu', async importOriginal => ({
  ...await importOriginal<typeof import('@/components/session-watch/SessionAppMenu')>(),
  SessionAppMenu: () => <button type="button" data-testid="session-app-menu">对话</button>,
}));
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

it('the same desktop task page elsewhere keeps its view switcher and its model and permission controls', async () => {
  await i18n.changeLanguage('zh-CN');
  await page.viewport(900, 860);
  document.documentElement.dataset.theme = 'light';
  harness = createReactHarness();
  harness.container.style.cssText = 'height:860px;width:900px;display:flex;flex-direction:column';
  await renderWithAppProviders(harness, <SessionTimelinePage device={DEVICE} session={SUMMARY} local onBack={() => undefined} />, { contacts: {} });
  await until('the session page composer', () => !!harness!.container.querySelector('[data-testid="composer-model-trigger"]'));
  const host = harness.container;
  expect(host.querySelector('[data-testid="agent-watch-timeline-page"]')!.hasAttribute('data-panel-layer')).toBe(false);
  expect(host.querySelector('[data-testid="agent-watch-hero"] [data-testid="session-app-menu"]')).not.toBeNull();
  expect(host.querySelector('.gg-aw-panel-back')).toBeNull();
  expect(host.textContent).toContain('完全访问');
  expect(host.querySelector('[data-composer-locked-agent]')).not.toBeNull();
});
