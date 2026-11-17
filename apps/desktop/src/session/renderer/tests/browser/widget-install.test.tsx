import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { WidgetBubble } from '@/components/chat/WidgetBubble';
import { createReactHarness } from '../../../../../../../tests/support/testHarness';
import { until } from '../../../../../../../tests/support/awaitCondition';
import { followRendererSession } from '@/lib/replica';
import { sharedAppPackages } from '@/components/extensionBundle/packageReplicas';

const state = vi.hoisted(() => ({
  manifests: [] as { id: string; version: string; contributes: { tabs: { name: string; widget?: { height: number } }[] } }[],
  shared: new Map(),
  installAttachment: vi.fn(), installFromMarket: vi.fn(), marketOffers: vi.fn(),
}));
vi.mock('react-i18next', async original => ({ ...(await original<object>()), useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/store/auth', async original => ({ ...(await original<object>()), useAuth: () => ({ user: { id: 'reader' } }) }));
vi.mock('@/components/chat/useConversationVisibility', () => ({ useConversationVisibility: () => ({ ref: () => undefined, shown: true }) }));
vi.mock('@/components/appSlot/appsHere', () => ({ appsHere: { ...state, runs: () => true, onMarketChanged: () => () => {} } }));
vi.mock('@/lib/widgetRegistry', async original => {
  const { parseWidgetMessage } = await import('@gugu/core/shared/ui/widgetModels');
  return { ...(await original<object>()), widgetForOriginal: async (message: import('@/lib/widgetRegistry').WidgetOriginMessage) => ({
    id: message.id, widget: parseWidgetMessage(message.content), senderId: message.sender_user_id,
  }) };
});
vi.mock('@/components/extensionBundle/sharedPackages', async original => ({
  ...(await original<object>()),
  // The chat's attachments: one card per package shared, read for its manifest (sharedAppPackages' read).
  chatPackageCards: async () => [...state.shared.values()].map((shared: ReturnType<typeof pkg>) => shared.card),
  readPackageSummary: async () => ({ ok: true, manifest: [...state.shared.values()][0].manifest }),
}));
vi.mock('@renderer/features/extensions/extension-view-layer', () => ({ ExtensionPage: () => <div>Widget view</div> }));
vi.mock('@/components/appSlot/PhoneAppFrame', () => ({ PhoneAppFrame: () => <div>Widget view</div> }));
vi.mock('@renderer/features/extensions/installed-extensions', async original => {
  const installed = {
  isLoaded: true, get manifests() { return state.manifests; }, origins: {},
  manifestFor: (id: string) => state.manifests.find(m => m.id === id), isEnabled: () => true,
}
  return { ...(await original<object>()), useInstalledApps: () => ({ state: 'value', stale: false, error: null, value: installed }),
    peekInstalledApps: () => installed, peekInstalledAppsTracked: () => installed, fetchInstalledApps: async () => installed }
});
const pkg = () => ({ manifest: { id: 'vote', name: 'Vote', version: '2.0.0', contributes: { tabs: [{ name: 'main', widget: { height: 200 } }] } }, card: { source: { kind: 'message', messageId: 'package-message' }, messageId: 'package-message' } });
const message = { id: 'widget', chat_id: 'chat', sender_user_id: 'agent', content: JSON.stringify({ v: 2, app: 'vote', view: 'main', text: 'Vote here' }) };
let harness: ReturnType<typeof createReactHarness>;
// The chat's shared packages are an account replica: read for a signed-in account.
followRendererSession('SIGNED_IN', 'reader');
beforeEach(() => {
  state.manifests = []; state.shared = new Map();
  state.installAttachment.mockReset().mockResolvedValue({ success: true, data: { installed: false, outcome: 'cancelled' } });
  state.installFromMarket.mockReset(); state.marketOffers.mockReset().mockResolvedValue({ success: true, data: [] });
});
afterEach(() => harness?.cleanup());
const button = () => [...harness.container.querySelectorAll('button')].find(b => b.textContent === 'chatArea.openWith.install');
async function mount(content = message.content) { harness = createReactHarness(); await harness.render(<WidgetBubble message={{ ...message, content }} />); }

it.each([{ height: 480, expected: 480 }, { height: 140, expected: 140 }, { height: undefined, expected: 200 }])('reserves the message height $height or the manifest default', async ({ height, expected }) => {
  state.manifests = [pkg().manifest];
  await mount(JSON.stringify({ v: 2, app: 'vote', view: 'main', text: 'Vote here', height }));
  const slot = harness.container.querySelector<HTMLElement>('[data-widget-bubble] > div');
  expect(slot).not.toBeNull();
  expect(getComputedStyle(slot!).height).toBe(`${expected}px`);
});
it('falls back to the manifest height when the message height is invalid', async () => {
  state.manifests = [pkg().manifest];
  await mount(JSON.stringify({ v: 2, app: 'vote', view: 'main', text: 'Vote here', height: 20 }));
  const slot = harness.container.querySelector<HTMLElement>('[data-widget-bubble] > div');
  expect(slot).not.toBeNull();
  expect(getComputedStyle(slot!).height).toBe('200px');
});

it('offers an unlisted package from this chat through the same attachment consent entry', async () => {
  state.shared.set('vote', pkg());
  await mount();
  await until('the shared App can be installed from the widget', () => !!button());
  button()!.click();
  await until('the original attachment installer is called', () => state.installAttachment.mock.calls.length === 1);
  expect(state.installAttachment).toHaveBeenCalledWith({ messageId: 'package-message', chatId: 'chat' });
  expect(state.installFromMarket).not.toHaveBeenCalled();
  await until('cancelling consent restores the button', () => !button()?.disabled);
  expect(harness.container.querySelector('[role="alert"]')).toBeNull();
});
it('offers a later chat package without reloading the widget', async () => {
  await mount();
  await until('the chat\'s packages were read: none yet', () => sharedAppPackages.peek('chat').state === 'value');
  expect(button()).toBeUndefined();
  state.shared = new Map([['vote', pkg()]]);
  // A package sent in the chat (the account revision's log push, ExtensionForwardHost): the chat is read again.
  void sharedAppPackages.refresh('chat');
  await until('the newly shared App is offered', () => !!button());
});
it('offers a newer package when the installed App lacks the widget view', async () => {
  state.manifests = [{ id: 'vote', version: '1.0.0', contributes: { tabs: [{ name: 'old' }] } }];
  state.shared.set('vote', pkg());
  await mount();
  await until('the new view is available to install', () => !!button());
  expect(harness.container.textContent).toContain('message.widgetUnavailable.view');
});
it('the chat\'s packages read before, a read again that fails keeps the offer and says the failure with a retry', async () => {
  state.manifests = [{ id: 'vote', version: '1.0.0', contributes: { tabs: [{ name: 'old' }] } }];
  state.shared.set('vote', pkg());
  await mount();
  await until('the new view is available to install', () => !!button());
  expect(harness.container.querySelector('[data-refresh-failed]')).toBeNull();
  const shared = state.shared;
  state.shared = new Map([['broken', { get card() { throw new Error('chat unreadable'); } }]]);
  await sharedAppPackages.refresh('chat').catch(() => undefined);
  await until('the failed read again is said', () => !!harness.container.querySelector('[data-refresh-failed]'));
  expect(button()).toBeDefined();
  state.shared = shared;
});
