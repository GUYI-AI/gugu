// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

/**
 * #1927 (API 48) The frame of an App's page beside its bound conversation puts the host's recording bar in the conversation's
 * column, after the native conversation's slot, as the built-in assistant page does (assistant-view.tsx) — the bar itself
 * decides whether that column is the assistant chat (app-conversation-voice-bar.test.tsx). No column, no bar.
 */
const CHAT = '33000000-0000-4000-8000-000000000003';
const state = vi.hoisted(() => ({ bars: [] as Record<string, unknown>[] }));
vi.mock('@renderer/features/extensions/extension-shared-slot', () => ({ ExtensionSharedSlot: () => <div data-testid="app-page" /> }));
vi.mock('@renderer/features/global-search/search-session', () => ({ searchInChat: vi.fn() }));
vi.mock('@renderer/lib/ipc', () => ({ rpc: { extensions: { reportConversationSurface: async () => ({ success: true }) } } }));
vi.mock('@renderer/lib/stores/app-state', () => ({ appState: { navigation: { navigate: vi.fn() } } }));
// The panel's own pages and their reads (app-host-layer.tsx), as app-conversation-frame.test.tsx: they read the cloud on import.
vi.mock('@renderer/features/assistant/assistant-data', () => ({ useAssistantMachine: () => ({ data: undefined }) }));
vi.mock('@/components/assistant/AssistantProjectsLibrary', () => ({ AssistantProjectsLibrary: () => null }));
vi.mock('@/components/assistant/AssistantLibraryVolume', () => ({ AssistantLibraryVolume: () => null }));
vi.mock('@renderer/features/apps/assistant-app-counts', () => ({ AssistantAppCountsSource: () => null }));
vi.mock('./app-conversation-voice-bar', () => ({
  default: (props: Record<string, unknown>) => { state.bars.push(props); return <div data-testid="voice-bar-here" />; },
}));

// The panel's own pages and their reads (app-host-layer.tsx): not this test's; their modules read the cloud on import.
vi.mock('@renderer/features/assistant/assistant-data', () => ({ useAssistantMachine: () => ({ data: undefined }) }));
vi.mock('@/components/assistant/AssistantProjectsLibrary', () => ({ AssistantProjectsLibrary: () => null }));
vi.mock('@/components/assistant/AssistantLibraryVolume', () => ({ AssistantLibraryVolume: () => null }));
vi.mock('@renderer/features/apps/assistant-app-counts', () => ({ AssistantAppCountsSource: () => null }));
const { AppConversationFrame } = await import('./app-conversation-frame');
const { installShellSlots } = await import('@/lib/shellSlots');
const { installAppConversationSurfaceBridge, publishAppConversationSurfaces } = await import('@/lib/appConversationSurfaceBridge');
installShellSlots();
installAppConversationSurfaceBridge();

let root: Root;
let element: HTMLDivElement;
const render = async () => { await act(async () => root.render(<AppConversationFrame extensionId="assistant-app" tabKind="assistant-app.main" />)); };

beforeEach(() => {
  state.bars.length = 0;
  element = document.createElement('div');
  document.body.append(element);
  root = createRoot(element);
});
afterEach(async () => {
  await act(async () => root.unmount());
  await act(async () => publishAppConversationSurfaces({}));
  element.remove();
});

describe('the recording bar in an App\'s conversation column', () => {
  it('after the conversation\'s slot, in its column, told the App and the chat; none while the page opens alone', async () => {
    await render();
    expect(element.querySelector('[data-testid="voice-bar-here"]')).toBeNull();
    await act(async () => publishAppConversationSurfaces({ 'assistant-app': CHAT }));
    await render();
    const column = element.querySelector('[data-testid="app-conversation-column"]');
    const bar = element.querySelector('[data-testid="voice-bar-here"]');
    expect(bar?.parentElement).toBe(column);
    expect(bar?.previousElementSibling?.getAttribute('data-app-conversation-slot')).toBe('assistant-app');
    // Identity, not toMatchObject: a subset match walks the whole jsdom node graph and never returns.
    expect(state.bars.at(-1)).toMatchObject({ extensionId: 'assistant-app', chatId: CHAT });
    expect(state.bars.at(-1)?.column).toBe(column);
  });
});
