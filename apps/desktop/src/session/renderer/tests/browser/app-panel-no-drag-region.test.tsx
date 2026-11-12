/**
 * Owner 11-12 (assistant App on the rail, MBP): 「任务 / 记忆 / 资料」 at the top of the App's panel "don't switch
 * properly". The page there is a webview drawn in the resident layer (ExtensionViewLayer), which App.tsx mounts before the
 * workspace; the session page's title band (`ShellTitlebarDragRegion`, a full-width drag strip) used to lie over the top of
 * the panel. Electron folds the drag / no-drag rectangles in that order, so the later band won over the webview's no-drag:
 * a real mouse press on the upper part of a tab started a window drag. CDP clicks skip the OS hit test, so no automated
 * check saw it.
 *
 * Judged here with real Chromium and real CSS, on the real App page (title bar + main panel in the workspace's content
 * layout) with a stand-in webview where the resident layer puts it:
 *   · no element whose computed `-webkit-app-region` is `drag` intersects the App's panel (nor the webview);
 *   · folding every drag / no-drag box in document order (what Electron does), no point of the App's tab row is a handle,
 *     while the conversation column's top band still is one and its buttons (search, gear, expand) are not;
 *   · another App's page keeps the window band above it, as before, and that band still does not reach the page.
 */
import { motionValue } from 'framer-motion';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import '@/i18n';
import '@gugu/session-ui/styles/global';
import '@gugu/session-ui/theme/theme.css';
import '@gugu/session-ui/theme/semantic.css';
import '@gugu/session-ui/styles/base.css';
import '@/styles/tokens.css';
import '@renderer/index.css';

const APP = 'gugu-assistant';
const CHAT = '33000000-0000-4000-8000-000000000003';
const OWNER = 'u1';
const state = vi.hoisted(() => ({ target: { kind: 'app' } as { kind: 'app' | 'chat' } }));

vi.mock('@/lib/assistantEntry', async (original) => ({
  ...await original<typeof import('@/lib/assistantEntry')>(),
  useAssistantEntryTarget: () => state.target.kind === 'app'
    ? { kind: 'app', extensionId: APP, chatId: CHAT }
    : { kind: 'chat', chatId: CHAT },
  openAssistantEntry: () => undefined,
}));
vi.mock('@renderer/lib/ipc', () => {
  const rpc = { extensions: { reportConversationSurface: async () => ({ success: true }) } };
  return { rpc, rpcOn: () => rpc, invokeOnMachine: async () => undefined, events: { on: () => () => {} }, onMachineEvent: () => () => {} };
});
vi.mock('@renderer/lib/layout/navigation-provider', async (original) => ({
  ...await original<typeof import('@renderer/lib/layout/navigation-provider')>(),
  useParams: () => ({ params: { appId: APP }, setParams: () => undefined }),
}));
vi.mock('@renderer/lib/layout/layout-provider', async (original) => ({
  ...await original<typeof import('@renderer/lib/layout/layout-provider')>(),
  useWorkspaceLayoutContext: () => ({ leftAnimatedWidth: motionValue(0), leftRail: 0 }),
}));
// The App's page itself is the stand-in webview below; the slot only holds its place, as the real one does.
vi.mock('@renderer/features/extensions/extension-shared-slot', () => ({
  ExtensionSharedSlot: () => <div className="flex min-h-0 flex-1" data-extension-slot="" />,
}));
vi.mock('@renderer/features/apps/app-conversation-voice-bar', () => ({ default: () => null }));
vi.mock('@renderer/features/global-search/search-session', () => ({ searchInChat: () => undefined }));
// The panel's own host pages and their reads (app-host-layer.tsx): not this test's; their modules read the cloud on import.
vi.mock('@renderer/features/assistant/assistant-data', () => ({ useAssistantMachine: () => ({ data: undefined }) }));
vi.mock('@/components/assistant/AssistantProjectsLibrary', () => ({ AssistantProjectsLibrary: () => null }));
vi.mock('@/components/assistant/AssistantLibraryVolume', () => ({ AssistantLibraryVolume: () => null }));
vi.mock('@renderer/features/apps/assistant-app-counts', () => ({ AssistantAppCountsSource: () => null }));

const { appView } = await import('@renderer/features/apps/apps-views');
const { WorkspaceContentLayout } = await import('@renderer/lib/layout/workspace-layout');
const { setAppConversationPanelCollapsed } = await import('@renderer/features/apps/app-conversation-panel');
const { installedExtensionsStore } = await import('@renderer/features/extensions/installed-extensions-store');
const { installAppConversationSurfaceBridge, publishAppConversationSurfaces } = await import('@/lib/appConversationSurfaceBridge');
const { installAssistantShellBridge, publishAssistantShell } = await import('@/lib/assistantShellBridge');
const { installShellSlots } = await import('@/lib/shellSlots');
const { EXTENSION_API_VERSION } = await import('@shared/extensions/manifest');

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

type Region = { element: Element; rect: DOMRect; drag: boolean };

let host: HTMLDivElement;
let root: Root;

/** Every box that sets a window region, in document order: the order Electron folds them (later wins). */
function regions(): Region[] {
  return [host, ...host.querySelectorAll('*')].flatMap((element) => {
    const value = getComputedStyle(element).getPropertyValue('-webkit-app-region');
    return value === 'drag' || value === 'no-drag' ? [{ element, rect: element.getBoundingClientRect(), drag: value === 'drag' }] : [];
  });
}
const inside = (rect: DOMRect, x: number, y: number) => x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom;
const intersects = (a: DOMRect, b: DOMRect) => a.width > 0 && a.height > 0 && a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
/** Whether a real mouse press at (x, y) would move the window: the last region over the point decides. */
function handleAt(x: number, y: number): boolean {
  let drag = false;
  for (const region of regions()) if (inside(region.rect, x, y)) drag = region.drag;
  return drag;
}
const byTestId = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`)!;
const centre = (element: Element): [number, number] => {
  const rect = element.getBoundingClientRect();
  return [rect.left + rect.width / 2, rect.top + rect.height / 2];
};

/** The resident layer's guest, where ExtensionViewLayer puts it: over the page's slot (hidden while no slot claims it). */
function placeWebview(): HTMLElement {
  const webview = host.querySelector<HTMLElement>('[data-testid="stand-in-webview"]')!;
  const slot = host.querySelector('[data-app-page-anchor]');
  if (!slot) {
    webview.style.display = 'none';
    return webview;
  }
  const anchor = slot.getBoundingClientRect();
  const box = host.getBoundingClientRect();
  Object.assign(webview.style, { position: 'absolute', display: 'block', left: `${anchor.left - box.left}px`, top: `${anchor.top - box.top}px`, width: `${anchor.width}px`, height: `${anchor.height}px` });
  return webview;
}

async function drawAppPage() {
  await act(async () => {
    root.render(
      <>
        {/* App.tsx: <ExtensionViewLayer /> before the workspace. */}
        <div data-slot="extension-view-layer" className="pointer-events-none absolute inset-0">
          <webview data-testid="stand-in-webview" />
        </div>
        <WorkspaceContentLayout titlebarSlot={<appView.TitlebarSlot />} mainPanel={<appView.MainPanel />} />
      </>
    );
  });
  await vi.waitFor(() => expect(host.querySelector('[data-testid="app-conversation-column"]')).not.toBeNull());
  return placeWebview();
}

beforeEach(async () => {
  await page.viewport(1280, 860);
  state.target.kind = 'app';
  localStorage.clear();
  installShellSlots();
  installAppConversationSurfaceBridge();
  installAssistantShellBridge();
  installedExtensionsStore.applyList({
    extensions: [{
      id: APP, name: 'Gugu', version: '1.0.0', apiVersion: EXTENSION_API_VERSION, defaultLocale: 'en', entry: 'index.html',
      contributes: { tabs: [{ name: 'main', title: 'Gugu' }], conversationSurface: { binding: 'conversation', header: 'assistant' } },
    }],
    invalid: [], icons: {}, appIcons: {}, disabled: [], disclosure: {}, dock: [APP],
  } as never);
  publishAssistantShell({
    cloudAvailable: false, canHostHere: true, cloud: null, loadError: null, assistant: { id: 'a1', display_name: '小咕', avatar: null, created_at: null },
    assistantState: 'found', ownerName: 'U', ownerId: OWNER, chatId: CHAT, home: null, setup: null, member: false, preparing: false,
  } as never);
  publishAppConversationSurfaces({ [APP]: CHAT }, { [APP]: { kind: 'assistant', ownerId: OWNER } });
  host = document.createElement('div');
  host.className = 'emlight gugu-skin';
  host.style.cssText = 'position: relative; width: 1200px; height: 800px;';
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  setAppConversationPanelCollapsed(APP, false);
  host.remove();
  publishAppConversationSurfaces({});
  installedExtensionsStore.applyList({ extensions: [], invalid: [], icons: {}, disabled: [], disclosure: {}, dock: [] } as never);
});

describe('no window drag region over an App\'s page', () => {
  it('the assistant\'s page: nothing over the App\'s panel is a handle; the column\'s top band is, its buttons are not', async () => {
    const webview = await drawAppPage();
    const panel = byTestId('app-conversation-panel').getBoundingClientRect();
    const column = byTestId('app-conversation-column').getBoundingClientRect();
    const drags = regions().filter((region) => region.drag);
    expect(drags.length, 'the window keeps a handle on this page').toBeGreaterThan(0);
    for (const region of drags) {
      expect(intersects(region.rect, panel), `drag box over the App's panel: ${region.element.outerHTML.slice(0, 120)}`).toBe(false);
      expect(intersects(region.rect, webview.getBoundingClientRect()), 'drag box over the webview').toBe(false);
    }
    // The App's own top row (its tabs sit 12–40px down the panel): no point of it moves the window.
    for (const y of [panel.top + 4, panel.top + 20, panel.top + 38]) {
      for (const x of [panel.left + 24, panel.left + panel.width / 2, panel.right - 60]) expect(handleAt(x, y), `App row at ${x},${y}`).toBe(false);
    }
    // The conversation column: an empty spot of its top band moves the window; its buttons are buttons.
    expect(handleAt(column.left + 24, column.top + 20), 'column top band is the handle').toBe(true);
    for (const id of ['app-conversation-search', 'app-conversation-gear', 'app-conversation-identity']) {
      expect(handleAt(...centre(byTestId(id))), id).toBe(false);
    }
  });

  it('the panel collapsed: the column\'s band is the handle across, the expand button stays a button', async () => {
    setAppConversationPanelCollapsed(APP, true);
    await drawAppPage();
    expect(host.querySelector('[data-testid="app-conversation-panel"]')).toBeNull();
    const column = byTestId('app-conversation-column').getBoundingClientRect();
    expect(handleAt(column.left + 24, column.top + 20)).toBe(true);
    expect(handleAt(column.right - 160, column.top + 20)).toBe(true);
    for (const id of ['app-conversation-search', 'app-conversation-gear', 'app-conversation-panel-expand']) {
      expect(handleAt(...centre(byTestId(id))), id).toBe(false);
    }
  });

  it('another App\'s page beside its conversation keeps the window band above it, and the band does not reach the page', async () => {
    state.target.kind = 'chat';
    const webview = await drawAppPage();
    const panel = byTestId('app-conversation-panel').getBoundingClientRect();
    const band = host.querySelector('[data-session-titlebar-drag-region]')!.getBoundingClientRect();
    expect(band.width, 'the title band spans the page as before').toBe(host.getBoundingClientRect().width);
    for (const region of regions().filter((r) => r.drag)) {
      expect(intersects(region.rect, panel)).toBe(false);
      expect(intersects(region.rect, webview.getBoundingClientRect())).toBe(false);
    }
    expect(host.querySelectorAll('[data-session-titlebar-drag-region]')).toHaveLength(1);
  });
});
