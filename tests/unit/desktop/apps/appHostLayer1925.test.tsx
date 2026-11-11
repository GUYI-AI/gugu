// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * #1925 (API 44) One host layer over an App's panel: the built-in panel's own page (settings, projects, capabilities) drawn
 * where the App's page was, with the host's back control; one at a time; taken away on back, on an account change, when the
 * window no longer shows the assistant and when the panel goes. Main hears each open and close (the App hears hostPage).
 */
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const D = '../../../../apps/desktop/src';
const reports = vi.hoisted(() => [] as unknown[]);
vi.mock('react-i18next', async (original) => ({ ...(await original<object>()), useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }) }));
vi.mock('../../../../apps/desktop/src/session/renderer/lib/ipc', () => ({ rpc: { extensions: {
  appHostLayerChanged: async (args: unknown) => { reports.push(args); return { success: true }; },
} } }));
vi.mock('../../../../apps/desktop/src/session/renderer/utils/logger', () => ({ log: { warn: vi.fn() } }));
vi.mock('../../../../apps/desktop/src/session/renderer/features/extensions/extension-shared-slot', () => ({ ExtensionSharedSlot: () => <div data-testid="app-page" /> }));
vi.mock('../../../../apps/desktop/src/session/renderer/features/extensions/installed-extensions-store', () => ({ installedExtensionsStore: { isEnabled: () => true, manifests: [] } }));
vi.mock('../../../../apps/desktop/src/session/renderer/features/assistant/assistant-data', () => ({ useAssistantMachine: () => ({ data: undefined }) }));
vi.mock('../../../../apps/desktop/src/session/renderer/features/assistant/assistant-profile', () => ({ ShellPage: ({ slot }: { slot: string }) => <div data-testid={`page-${slot}`} /> }));
vi.mock('../../../../apps/desktop/src/components/assistant/AssistantProjectsLibrary', () => ({ AssistantProjectsLibrary: () => <div data-testid="page-projects" /> }));
vi.mock('../../../../apps/desktop/src/components/assistant/AssistantLibraryVolume', () => ({ AssistantLibraryVolume: ({ kind }: { kind: string }) => <div data-testid={`page-${kind}`} /> }));
vi.mock('../../../../apps/desktop/src/session/renderer/features/apps/assistant-app-counts', () => ({ AssistantAppCountsSource: () => null }));
vi.mock('../../../../apps/desktop/src/lib/myAssistant', () => ({ isMyAssistant: () => false }));

const { installAssistantShellBridge, publishAssistantShell } = await import(`${D}/lib/assistantShellBridge`);
const { AppHostLayerFrame, openAssistantLayer, resetAppHostLayersForTest } = await import(`${D}/session/renderer/features/apps/app-host-layer`);

const OWNER = '11000000-0000-4000-8000-000000000001';
const OTHER = '22000000-0000-4000-8000-000000000002';
const APP = 'assistant-app';
const shell = (over: Record<string, unknown> = {}) => ({
  cloudAvailable: true, canHostHere: true, cloud: null, loadError: null,
  assistant: { id: '44000000-0000-4000-8000-000000000004', display_name: 'Dot', avatar: null, created_at: null },
  assistantState: 'found', ownerName: 'Ann', deviceCount: 2, ownerId: OWNER, ownerAvatar: null, chatId: null, chatReadFailed: false,
  home: null, setup: null, member: null, preparing: false, ...over,
}) as never;

let root: Root;
let container: HTMLDivElement;
const shown = () => [...container.querySelectorAll('[data-testid]')].map((node) => node.getAttribute('data-testid'));
const mount = () => act(() => root.render(<AppHostLayerFrame extensionId={APP} tabKind={`${APP}.main`} />));
const open = (screen: 'settings' | 'projects' | 'capabilities', owner = OWNER) => act(() => openAssistantLayer(APP, screen, owner));

beforeEach(() => {
  resetAppHostLayersForTest();
  reports.length = 0;
  installAssistantShellBridge();
  publishAssistantShell(shell());
  container = document.body.appendChild(document.createElement('div'));
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('the host layer over an App\'s panel', () => {
  it.each([['settings', 'page-settings'], ['projects', 'page-projects'], ['capabilities', 'page-capabilities']] as const)(
    '%s: the built-in page in the App\'s place, with the host\'s back; back gives the App its page again', (screen, testId) => {
      mount();
      expect(shown()).toEqual(['app-page']);
      open(screen);
      expect(shown()).toEqual(['app-host-layer', 'app-host-layer-back', testId]);
      expect(reports).toEqual([{ extensionId: APP, layer: { kind: `assistant-${screen}`, ownerId: OWNER } }]);
      act(() => (container.querySelector('[data-testid="app-host-layer-back"]') as HTMLButtonElement).click());
      expect(shown()).toEqual(['app-page']);
      expect(reports.at(-1)).toEqual({ extensionId: APP, layer: null });
    });

  it('one at a time: a second takes the first one\'s place', () => {
    mount();
    open('projects');
    open('settings');
    expect(shown()).toContain('page-settings');
    expect(shown()).not.toContain('page-projects');
    expect(reports.map((report) => (report as { layer: { kind: string } | null }).layer?.kind)).toEqual(['assistant-projects', 'assistant-settings']);
  });

  it('refused, drawing nothing, for another account, while the assistant is not shown, or with no panel on screen', () => {
    expect(() => openAssistantLayer(APP, 'settings', OWNER)).toThrow();
    mount();
    expect(() => openAssistantLayer(APP, 'settings', OTHER)).toThrow();
    act(() => publishAssistantShell(shell({ assistantState: 'loading', assistant: null })));
    expect(() => openAssistantLayer(APP, 'settings', OWNER)).toThrow();
    expect(shown()).toEqual(['app-page']);
    expect(reports).toEqual([]);
  });

  it('taken away on an account change, or when the window no longer shows the assistant', () => {
    mount();
    open('capabilities');
    act(() => publishAssistantShell(shell({ ownerId: OTHER })));
    expect(shown()).toEqual(['app-page']);
    expect(reports.at(-1)).toEqual({ extensionId: APP, layer: null });
    act(() => publishAssistantShell(shell()));
    open('settings');
    act(() => publishAssistantShell(shell({ assistantState: 'none', assistant: null })));
    expect(shown()).toEqual(['app-page']);
    expect(reports.at(-1)).toEqual({ extensionId: APP, layer: null });
  });

  it('taken away when the panel goes: main hears it closed', () => {
    mount();
    open('projects');
    act(() => root.render(<div />));
    expect(reports.at(-1)).toEqual({ extensionId: APP, layer: null });
    expect(() => openAssistantLayer(APP, 'projects', OWNER)).toThrow();
  });
});
