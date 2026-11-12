// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * #1925 (API 44) One host layer over an App's panel: the built-in panel's own page (settings, projects, capabilities) drawn
 * where the App's page was, with the host's back control; one at a time; taken away on back, on an account change, when the
 * window no longer shows the assistant and when the panel goes. The layer is the shell's one record per App (the same one a
 * task's conversation, API 46, uses); the shell tells main each open and close (AppWorkLedgerHost.test.tsx).
 */
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const D = '../../../../apps/desktop/src';
vi.mock('react-i18next', async (original) => ({ ...(await original<object>()), useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }) }));
vi.mock('../../../../apps/desktop/src/session/renderer/utils/logger', () => ({ log: { warn: vi.fn() } }));
vi.mock('../../../../apps/desktop/src/session/renderer/features/extensions/extension-shared-slot', () => ({ ExtensionSharedSlot: () => <div data-testid="app-page" /> }));
vi.mock('../../../../apps/desktop/src/session/renderer/features/extensions/installed-extensions-store', () => ({ installedExtensionsStore: { isEnabled: () => true, manifests: [] } }));
vi.mock('../../../../apps/desktop/src/session/renderer/features/assistant/assistant-data', () => ({ useAssistantMachine: () => ({ data: undefined }) }));
vi.mock('../../../../apps/desktop/src/session/renderer/features/assistant/assistant-ui', () => ({
  AssistantShellPageFrame: ({ testId, children }: { testId: string; children: unknown }) => <div data-testid={testId}>{children as never}</div>,
}));
vi.mock('../../../../apps/desktop/src/components/assistant/AssistantProjectsLibrary', () => ({ AssistantProjectsLibrary: () => <div data-testid="page-projects" /> }));
vi.mock('../../../../apps/desktop/src/components/assistant/AssistantLibraryVolume', () => ({ AssistantLibraryVolume: ({ kind }: { kind: string }) => <div data-testid={`page-${kind}`} /> }));
vi.mock('../../../../apps/desktop/src/session/renderer/features/apps/assistant-app-counts', () => ({ AssistantAppCountsSource: () => null }));
vi.mock('../../../../apps/desktop/src/lib/myAssistant', () => ({ isMyAssistant: () => false }));
// The engine draws in WebGL, which jsdom has not: who is drawn, and how big, is what is checked here.
vi.mock('../../../../apps/desktop/src/components/agentAvatar/AgentAvatar', () => ({
  AgentAvatar: ({ id, size, look }: { id: string; size: number; look?: unknown }) => <div data-testid={`avatar-${id}`} data-size={size} data-look={look ? 'default' : 'own'} />,
}));

const { installAssistantShellBridge, publishAssistantShell } = await import(`${D}/lib/assistantShellBridge`);
const { AppHostLayerFrame, openAssistantLayer, setAssistantFigure, appPageNewDocument, pageKey, resetMountedAppPagesForTest, useAppHostLayer } = await import(`${D}/session/renderer/features/apps/app-host-layer`);
const { installAppHostLayerBridge, readAppHostLayerBridge, resetAppHostLayersForTest, setAppHostLayerAccount } = await import(`${D}/lib/appHostLayerBridge`);
installAppHostLayerBridge();

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
/** The App's page where it stands (a box around it, for the figure, 44). */
const PAGE = ['app-page-anchor', 'app-page'];
const PANEL = pageKey(null, 'dock');
const open = (screen: 'settings' | 'projects' | 'capabilities', owner = OWNER) => act(() => openAssistantLayer(APP, screen, owner, PANEL));
/** The shell's record of this App's layer (what it tells main). */
const layer = () => readAppHostLayerBridge()!.getSnapshot()[APP] ?? null;

beforeEach(() => {
  resetAppHostLayersForTest();
  resetMountedAppPagesForTest();
  setAppHostLayerAccount(OWNER);
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
  it.each([
    // The settings: the shell draws the built-in page into this App's own cell (AppHostLayerHost).
    ['settings', ['app-host-layer-assistant-settings', 'app-host-layer-cell']],
    ['projects', ['page-projects']],
    ['capabilities', ['page-capabilities']],
  ] as const)('%s: the built-in page in the App\'s place, with the host\'s back; back gives the App its page again', (screen, page) => {
    mount();
    expect(shown()).toEqual(PAGE);
    open(screen);
    expect(shown()).toEqual(['app-host-layer', 'app-host-layer-back', ...page]);
    expect(layer()).toEqual({ kind: `assistant-${screen}`, ownerId: OWNER });
    act(() => (container.querySelector('[data-testid="app-host-layer-back"]') as HTMLButtonElement).click());
    expect(shown()).toEqual(PAGE);
    expect(layer()).toBeNull();
  });

  it('one at a time: a second takes the first one\'s place', () => {
    mount();
    open('projects');
    open('settings');
    expect(shown()).toContain('app-host-layer-assistant-settings');
    expect(shown()).not.toContain('page-projects');
    expect(layer()).toEqual({ kind: 'assistant-settings', ownerId: OWNER });
  });

  it('refused, drawing nothing, for another account, while the assistant is not shown, or with no panel on screen', () => {
    expect(() => openAssistantLayer(APP, 'settings', OWNER, PANEL)).toThrow();
    mount();
    expect(() => openAssistantLayer(APP, 'settings', OTHER, PANEL)).toThrow();
    act(() => publishAssistantShell(shell({ assistantState: 'loading', assistant: null })));
    expect(() => openAssistantLayer(APP, 'settings', OWNER, PANEL)).toThrow();
    expect(shown()).toEqual(PAGE);
    expect(layer()).toBeNull();
  });

  it('taken away on an account change, or when the window no longer shows the assistant', () => {
    mount();
    open('capabilities');
    act(() => publishAssistantShell(shell({ ownerId: OTHER })));
    expect(shown()).toEqual(PAGE);
    expect(layer()).toBeNull();
    act(() => publishAssistantShell(shell()));
    open('settings');
    act(() => publishAssistantShell(shell({ assistantState: 'none', assistant: null })));
    expect(shown()).toEqual(PAGE);
    expect(layer()).toBeNull();
  });

  it('not drawn even for the one render before it is closed: what each render saw after the account changed', () => {
    const seen: (string | null)[] = [];
    function Probe() {
      seen.push(useAppHostLayer(APP));
      return null;
    }
    act(() => root.render(<><AppHostLayerFrame extensionId={APP} tabKind={`${APP}.main`} /><Probe /></>));
    open('capabilities');
    expect(seen.at(-1)).toBe('assistant-capabilities');
    const from = seen.length;
    act(() => publishAssistantShell(shell({ ownerId: OTHER })));
    expect(seen.length).toBeGreaterThan(from);
    expect(seen.slice(from).every((kind) => kind === null)).toBe(true);
  });

  it('taken away when the panel goes: main hears it closed', () => {
    mount();
    open('projects');
    act(() => root.render(<div />));
    expect(layer()).toBeNull();
    expect(() => openAssistantLayer(APP, 'projects', OWNER, PANEL)).toThrow();
  });

  it('closed by a new document of the page that opened it (a reload, the one a changed grant makes) — not another page\'s', () => {
    mount();
    open('settings');
    act(() => appPageNewDocument(APP, pageKey(null, 'other-tab')));
    expect(shown()).toContain('app-host-layer-assistant-settings');
    act(() => appPageNewDocument(APP, PANEL));
    expect(shown()).toEqual(PAGE);
    expect(layer()).toBeNull();
  });
});

describe('the assistant\'s figure over an App\'s page', () => {
  const WHERE = { x: 24, y: 40, size: 96 };
  const drawn = () => document.body.querySelector('[data-testid="app-assistant-figure"]') as HTMLElement | null;
  const figure = (over: Record<string, unknown> = {}) => act(() => setAssistantFigure(APP, { figure: WHERE, ownerId: OWNER, who: 'assistant', from: PANEL, ...over } as never));

  it('the assistant itself, at the place the page said, over the page, clipped to it and letting clicks through; null takes it away', () => {
    mount();
    figure();
    const over = drawn()!;
    expect(over.dataset.who).toBe('assistant');
    expect(over.style.position).toBe('fixed');
    expect(over.style.overflow).toBe('hidden');
    expect(over.style.pointerEvents).toBe('none');
    const spot = over.firstElementChild as HTMLElement;
    expect([spot.style.left, spot.style.top, spot.style.width]).toEqual(['24px', '40px', '96px']);
    expect(over.querySelector('[data-testid="avatar-44000000-0000-4000-8000-000000000004"]')?.getAttribute('data-size')).toBe('96');
    act(() => setAssistantFigure(APP, null));
    expect(drawn()).toBeNull();
  });

  it('with no assistant yet: the setup guide\'s bird', () => {
    act(() => publishAssistantShell(shell({ assistantState: 'none', assistant: null, setup: 'shell' })));
    mount();
    figure({ who: 'draft' });
    expect(drawn()?.dataset.who).toBe('draft');
    expect(drawn()?.querySelector('[data-testid="avatar-assistant-draft"]')?.getAttribute('data-look')).toBe('default');
  });

  it('refused, drawing nothing: no panel on screen, another account, the assistant where the window shows none, the bird where it shows one', () => {
    expect(() => setAssistantFigure(APP, { figure: WHERE, ownerId: OWNER, who: 'assistant', from: PANEL })).toThrow();
    mount();
    expect(() => setAssistantFigure(APP, { figure: WHERE, ownerId: OTHER, who: 'assistant', from: PANEL })).toThrow();
    expect(() => setAssistantFigure(APP, { figure: WHERE, ownerId: OWNER, who: 'draft', from: PANEL })).toThrow();
    act(() => publishAssistantShell(shell({ assistantState: 'none', assistant: null })));
    expect(() => setAssistantFigure(APP, { figure: WHERE, ownerId: OWNER, who: 'assistant', from: PANEL })).toThrow();
    expect(drawn()).toBeNull();
  });

  it('taken away on an account change, when the assistant appears or goes, when the panel goes, and with the page\'s document', () => {
    mount();
    figure();
    act(() => publishAssistantShell(shell({ ownerId: OTHER })));
    expect(drawn()).toBeNull();
    act(() => publishAssistantShell(shell()));
    expect(drawn()).toBeNull();
    figure();
    act(() => publishAssistantShell(shell({ assistantState: 'none', assistant: null })));
    expect(drawn()).toBeNull();
    figure({ who: 'draft' });
    act(() => publishAssistantShell(shell()));
    expect(drawn()).toBeNull();
    figure();
    act(() => appPageNewDocument(APP, pageKey(null, 'other-tab')));
    expect(drawn()).not.toBeNull();
    act(() => appPageNewDocument(APP, PANEL));
    expect(drawn()).toBeNull();
    figure();
    act(() => root.render(<div />));
    expect(drawn()).toBeNull();
    mount();
    expect(drawn()).toBeNull();
  });

  it('not drawn over a host page open in the App\'s place', () => {
    mount();
    figure();
    open('settings');
    expect(drawn()).toBeNull();
  });
});
