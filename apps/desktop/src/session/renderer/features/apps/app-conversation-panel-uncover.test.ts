// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * #1927 (API 48) Before main tells an App's page an intent (a composer entry's `page-intent`, the recording bar's open), the
 * window expands that page's panel and closes any host page over it (`conversationPanel` with `uncover`), as the host's row
 * does for `profile`. Without `uncover`, a page's own `setPanel` leaves a host page where it is.
 */
const OWNER = '11000000-0000-4000-8000-000000000001';
vi.mock('@renderer/lib/ipc', () => ({ rpc: { extensions: {} } }));
vi.mock('@renderer/lib/stores/app-state', () => ({ appState: { navigation: { navigate: vi.fn() } } }));

const { applyExtensionHostAction } = await import('@renderer/features/extensions/host-action-handlers');
const { installAppHostLayerBridge, readAppHostLayerBridge, resetAppHostLayersForTest, setAppHostLayerAccount } = await import('@/lib/appHostLayerBridge');
const { setAppConversationPanelCollapsed, appConversationPanelCollapsed } = await import('./app-conversation-panel');
installAppHostLayerBridge();

const panel = (uncover?: true) => applyExtensionHostAction({
  origin: { extensionId: 'assistant-app', sessionId: null, tabId: 'dock' },
  action: { kind: 'conversationPanel', collapsed: false, ...(uncover ? { uncover } : {}) },
});

beforeEach(() => {
  localStorage.clear();
  setAppHostLayerAccount(OWNER);
  readAppHostLayerBridge()!.open('assistant-app', { kind: 'assistant-settings', ownerId: OWNER });
  setAppConversationPanelCollapsed('assistant-app', true);
});
afterEach(() => resetAppHostLayersForTest());

describe('the panel uncovered for an intent', () => {
  it('uncover: expanded and the host page over it closed; without it, the host page stays', async () => {
    await panel();
    expect(appConversationPanelCollapsed('assistant-app')).toBe(false);
    expect(readAppHostLayerBridge()!.getSnapshot()['assistant-app']).toMatchObject({ kind: 'assistant-settings' });
    setAppConversationPanelCollapsed('assistant-app', true);
    await panel(true);
    expect(appConversationPanelCollapsed('assistant-app')).toBe(false);
    expect(readAppHostLayerBridge()!.getSnapshot()['assistant-app']).toBeUndefined();
  });
});
