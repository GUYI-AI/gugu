import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// An App opened from the far-left rail (统筹 10-01): the page it shows is the one its last task's session tab shows —
// the same place, so the same live page moved here, not a second one. What the dock claims is what this reads.
const mocks = vi.hoisted(() => ({
  claims: [] as Record<string, unknown>[],
  params: {} as { appId?: string; tab?: string },
  lastSession: undefined as { projectId: string; sessionId: string } | undefined,
  main: null as { kind: string; enabled: boolean; extensionName: string; extensionId?: string } | null,
  manifest: undefined as { contributes: Record<string, unknown> } | undefined,
  frames: [] as Record<string, unknown>[],
  tabs: [] as { kind: string; enabled: boolean; extensionName: string; extensionId: string }[],
  said: { title: null, badge: null, error: null } as { title: string | null; badge: string | number | null; error: string | null },
  saidFor: [] as [string | null, string][],
  toggle: null as null | (() => void),
  target: { kind: 'built-in' } as { kind: 'built-in' } | { kind: 'app'; extensionId: string; chatId: string } | { kind: 'chat'; chatId: string },
  loaded: true,
  opened: 0,
}));
// Entry switch: where the assistant's entry goes now (lib/assistantEntry.ts's one decision).
vi.mock('@/lib/assistantEntry', () => ({ ASSISTANT_APP_ID: 'gugu-assistant', useAssistantEntryTarget: () => mocks.target, openAssistantEntry: () => { mocks.opened += 1; } }));

vi.mock('@renderer/features/extensions/extension-surface-store', async (original) => ({
  ...await original<typeof import('@renderer/features/extensions/extension-surface-store')>(),
  extensionSurfaceStore: {
    said: (sessionId: string | null, tabId: string) => {
      mocks.saidFor.push([sessionId, tabId]);
      return mocks.said;
    },
  },
}));

vi.mock('@renderer/features/extensions/extension-shared-slot', () => ({
  ExtensionSharedSlot: (props: Record<string, unknown>) => {
    mocks.claims.push(props);
    return null;
  },
}));
// #1925 (44) The App's main page stands in its host layer frame: with no layer open, that is the same shared slot.
vi.mock('./app-host-layer', () => ({
  AppHostLayerFrame: ({ tabKind }: { tabKind: string }) => {
    mocks.claims.push({ tabKind, tabId: 'dock' });
    return null;
  },
}));
vi.mock('@renderer/features/extensions/installed-extensions-store', () => ({
  installedExtensionsStore: { mainTabOf: () => mocks.main, manifestFor: () => mocks.manifest, get isLoaded() { return mocks.loaded; }, get allTabContributions() { return mocks.tabs; } },
}));
// #1925 The frame beside a bound conversation is app-conversation-frame.test.tsx's: here, only whether it is chosen.
vi.mock('./app-conversation-frame', () => ({
  AppConversationFrame: (props: Record<string, unknown>) => { mocks.frames.push(props); return null; },
}));
vi.mock('@renderer/lib/layout/navigation-provider', () => ({ useParams: () => ({ params: mocks.params }) }));
vi.mock('@renderer/lib/stores/app-state', () => ({
  appState: { navigation: { viewParamsStore: { get session() { return mocks.lastSession; } } } },
}));
vi.mock('@renderer/features/sessions/stores/session-selectors', () => ({
  getSessionPageStore: (projectId: string, sessionId: string) =>
    projectId === 'project-1' && sessionId === 'task-1' ? { workspaceId: 'workspace-1', viewModel: { paneLayout: {} } } : undefined,
}));
vi.mock('@renderer/features/sessions/stores/workspace-registry', () => ({
  workspaceRegistry: { get: () => ({ path: '/repo/task-1' }) },
}));
vi.mock('@renderer/features/sessions/view/session-pane-policy', () => ({ activeChatSessionId: () => 'conversation-1' }));
vi.mock('@renderer/localization/use-session-messages', () => ({ useSessionMessages: () => ({ translate: (key: string) => key }) }));
// The 「App」 page's own pieces: not what this file judges.
vi.mock('@renderer/features/library/library-view', () => ({ useSelectedLibraryHost: vi.fn() }));
vi.mock('@renderer/features/library/extensions-library-page', () => ({ ExtensionsLibraryPage: () => null }));
vi.mock('@renderer/features/library/library-host', () => ({ LibraryHostProvider: () => null }));
vi.mock('@renderer/features/remote-hosts/device-scope-picker', () => ({ DeviceScopeProvider: () => null }));
vi.mock('@renderer/features/remote-hosts/device-scope-store', () => ({ libraryDeviceStore: {} }));
vi.mock('@renderer/lib/components/page-layout', () => ({ PageContent: () => null, PageLayout: () => null }));
vi.mock('@renderer/lib/components/titlebar/shell-titlebar', () => ({ ShellTitlebar: ({ leftSlot, children }: { leftSlot?: ReactNode; children?: ReactNode }) => <>{leftSlot}{children}</> }));
// The chat panel's own mark (AppErrorMark): this file judges where it is put and that it opens, not how it looks.
vi.mock('@/components/appSlot/AppErrorMark', () => ({
  AppErrorMark: (props: { error: string; onToggle: () => void; testId: string }) => {
    mocks.toggle = props.onToggle;
    return <button type="button" data-testid={props.testId} title={props.error} />;
  },
  AppErrorDetails: (props: { error: string; testId: string }) => <div data-testid={props.testId}>{props.error}</div>,
}));

const { appView, appsView } = await import('./apps-views');
const { WINDOW_CONTROL_BAR_HEIGHT_PX } = await import('@/lib/window-chrome');

describe('an App opened from the far-left rail', () => {
  beforeEach(() => {
    mocks.claims.length = 0;
    mocks.frames.length = 0;
    mocks.tabs = [];
    mocks.manifest = { contributes: {} };
    mocks.saidFor.length = 0;
    mocks.said = { title: null, badge: null, error: null };
    mocks.params = { appId: 'clock' };
    mocks.main = { kind: 'clock.main', enabled: true, extensionName: 'Clock' };
    mocks.lastSession = { projectId: 'project-1', sessionId: 'task-1' };
    mocks.target = { kind: 'built-in' };
  });

  it('uses the same live page title as its task tab and keeps the App name as the initial title', () => {
    expect(renderToStaticMarkup(<appView.TitlebarSlot />)).toContain('>Clock</span>');
    mocks.said = { title: 'Timer running', badge: null, error: null };
    const markup = renderToStaticMarkup(<appView.TitlebarSlot />);
    expect(markup).toContain('>Timer running</span>');
    expect(markup).not.toContain('>Clock</span>');
    expect(mocks.saidFor).toContainEqual([null, 'dock']);
  });

  // 真源原则 13: the rail's App sits nowhere — what the person is looking at is `getAppState()`'s. Control (the parent
  // commit cbe5b6fd36): it claimed the last session looked at, and its context said that session (before L11 复核 49,
  // a made-up 'draft').
  it('claims its page in no session, a session looked at or not: no session id, no working copy', () => {
    renderToStaticMarkup(<appView.MainPanel />);
    expect(mocks.claims).toEqual([{ tabKind: 'clock.main', tabId: 'dock' }]);
  });

  // 125 10-06 (R's A/B): an App whose page draws from its top edge sat beneath its own name — 「R dice」 over 「Score 17」.
  // The title bar is a zero-height band over the main area; the page starts under it, as a session's tabs do. Control
  // (the parent commit): the slot filled the main area from its top, no room left.
  it('its page starts under the title band (the App\'s name, the window\'s handle), as a session\'s tabs do', () => {
    const markup = renderToStaticMarkup(<appView.MainPanel />);
    expect(markup).toContain(`padding-top:${WINDOW_CONTROL_BAR_HEIGHT_PX}px`);
    expect(mocks.claims).toEqual([{ tabKind: 'clock.main', tabId: 'dock' }]);
  });

  // 125 10-06 (R's A/B): reportError lit the chat panel's red dot and a session tab, but the App's own page — where a notify
  // or link naming no place opens — showed nothing. The same mark as the chat panel's (AppErrorMark), read from the page's
  // own slot. Control (the parent commit): no mark at all.
  // 125 10-06 04:51: where the chat panel puts it — in the title row beside the name, not a row of its own with a line
  // under it; pressed, the whole of it opens over the page.
  it('a page that reported an error shows the chat panel\'s mark beside its name in the title row; pressed, the whole of it', () => {
    mocks.said = { title: null, badge: null, error: 'Could not save: the disk is full' };
    const title = renderToStaticMarkup(<appView.TitlebarSlot />);
    expect(mocks.saidFor).toContainEqual([null, 'dock']);
    expect(title).toMatch(/Clock<\/span><button[^>]*data-testid="app-page-error"[^>]*title="Could not save: the disk is full"/);
    // The page itself has no row of its own for it, and no text until the mark is pressed.
    expect(renderToStaticMarkup(<appView.MainPanel />)).not.toContain('app-page-error');
    mocks.toggle!();
    expect(renderToStaticMarkup(<appView.MainPanel />)).toContain('<div data-testid="app-page-error-details">Could not save: the disk is full</div>');
    mocks.toggle!();
    expect(renderToStaticMarkup(<appView.MainPanel />)).not.toContain('app-page-error-details');
    mocks.said = { title: null, badge: null, error: null };
    expect(renderToStaticMarkup(<appView.TitlebarSlot />)).not.toContain('app-page-error');
  });

  it('switched off, it claims nothing and says where it is switched back on — under the title bar, as the page would sit', () => {
    mocks.main = { kind: 'clock.main', enabled: false, extensionName: 'Clock' };
    // The title bar is a band over the top of the main area: the line sits in the page's own frame, which starts under
    // it — before, a bare line drew from the top edge, over the App's name and the window's buttons.
    expect(renderToStaticMarkup(<appView.MainPanel />)).toMatch(/data-testid="app-page"[^>]*>[^]*extensions\.turnOnInSettings/);
    expect(renderToStaticMarkup(<appView.MainPanel />)).toContain(`padding-top:${WINDOW_CONTROL_BAR_HEIGHT_PX}px`);
    expect(mocks.claims).toEqual([]);
  });

  // Real window (verify-pass1 D9): the window restored to the assistant App's page while the App was not installed yet (the entry
  // said 「正在准备你的咕咕…」 at the same time); the page said only 「已停用：到「App」里启用」 — false, nothing was switched off. The
  // assistant App's page says it is getting ready (and gives way to the assistant's chat: assistant-page-not-here.test.tsx); any other
  // App, or the assistant App where the entry does go to it, is still told it is switched off.
  it('the assistant App\'s page restored while the App is not here says it is getting ready, never that it is switched off', () => {
    mocks.params = { appId: 'gugu-assistant' };
    mocks.target = { kind: 'chat', chatId: 'dm-1' };
    for (const main of [null, { kind: 'gugu-assistant.main', enabled: false, extensionName: '咕咕助理', extensionId: 'gugu-assistant' }]) {
      mocks.main = main;
      const page = renderToStaticMarkup(<appView.MainPanel />);
      expect(page).toContain('extensions.assistantPreparing');
      expect(page).not.toContain('extensions.turnOnInSettings');
      expect(mocks.claims).toEqual([]);
    }
  });

  it('any other App not here, and the assistant App on the entry\'s target, keep the switched-off line', () => {
    mocks.main = null;
    mocks.params = { appId: 'clock' };
    expect(renderToStaticMarkup(<appView.MainPanel />)).toContain('extensions.turnOnInSettings');
    mocks.params = { appId: 'gugu-assistant' };
    mocks.target = { kind: 'app', extensionId: 'gugu-assistant', chatId: 'dm-1' };
    const page = renderToStaticMarkup(<appView.MainPanel />);
    expect(page).toContain('extensions.turnOnInSettings');
    expect(page).not.toContain('extensions.assistantPreparing');
  });

  // #1925 Only an App placing its main page beside its binding gets the conversation's frame; every other page is as before.
  it('an App whose main page is placed beside its bound conversation gets that frame; any other page is drawn as before', () => {
    mocks.main = { kind: 'today.main', enabled: true, extensionName: 'Today', extensionId: 'today' };
    mocks.manifest = { contributes: { conversationSurface: { binding: 'main', placement: 'side-panel' } } };
    renderToStaticMarkup(<appView.MainPanel />);
    expect(mocks.frames).toEqual([{ extensionId: 'today', tabKind: 'today.main', windowHandle: false }]);
    expect(mocks.claims).toEqual([]);
    // Another of its tabs, opened by name, is not the main page: it is drawn alone, as before.
    mocks.frames.length = 0;
    mocks.params = { appId: 'today', tab: 'notes' };
    mocks.tabs = [{ kind: 'today.notes', enabled: true, extensionName: 'Today', extensionId: 'today' }];
    renderToStaticMarkup(<appView.MainPanel />);
    expect(mocks.frames).toEqual([]);
    expect(mocks.claims).toEqual([{ tabKind: 'today.notes', tabId: 'dock' }]);
  });

  // Real window (verify-pass1 11-b, 14-b): the App as the assistant's page had the App page's title over it — 「咕咕助理」, a
  // gear, open in window — and its frame started under that band. The built-in assistant page had neither. Control (the
  // parent commit): the name and both buttons drawn, the page padded under the band.
  it('as the assistant\'s page (the entry goes to it) it has no title of its own and starts at the top, as the built-in page did', () => {
    mocks.params = { appId: 'gugu-assistant' };
    mocks.main = { kind: 'gugu-assistant.main', enabled: true, extensionName: '咕咕助理', extensionId: 'gugu-assistant' };
    mocks.manifest = { contributes: { conversationSurface: { binding: 'main', placement: 'side-panel', header: 'assistant' } } };
    const before = renderToStaticMarkup(<appView.TitlebarSlot />);
    expect(before).toContain('>咕咕助理</span>');
    expect(before).toContain('data-testid="app-page-settings"');
    expect(before).toContain('data-testid="app-page-open-in-window"');
    expect(renderToStaticMarkup(<appView.MainPanel />)).toContain(`padding-top:${WINDOW_CONTROL_BAR_HEIGHT_PX}px`);

    mocks.target = { kind: 'app', extensionId: 'gugu-assistant', chatId: 'dm-1' };
    const title = renderToStaticMarkup(<appView.TitlebarSlot />);
    expect(title).not.toContain('咕咕助理');
    expect(title).not.toContain('app-page-settings');
    expect(title).not.toContain('app-page-open-in-window');
    const page = renderToStaticMarkup(<appView.MainPanel />);
    expect(page).not.toContain('padding-top');
    expect(page).toContain('data-assistant-page=""');
    // Its page starts at the window's top: the column carries the window's handle, not a band over the App's panel (owner 11-12).
    expect(mocks.frames.at(-1)).toEqual({ extensionId: 'gugu-assistant', tabKind: 'gugu-assistant.main', windowHandle: true });
    // A reported error still has its mark on the band, and nothing else of the App's.
    mocks.said = { title: null, badge: null, error: 'Could not read today.json' };
    expect(renderToStaticMarkup(<appView.TitlebarSlot />)).toMatch(/^<button[^>]*data-testid="app-page-error"[^>]*title="Could not read today.json"[^>]*><\/button>$/);
  });

  it('the same App keeps its title bar for another of its tabs, and wherever the entry does not go to it', () => {
    mocks.manifest = { contributes: { conversationSurface: { binding: 'main', placement: 'side-panel', header: 'assistant' } } };
    mocks.target = { kind: 'app', extensionId: 'gugu-assistant', chatId: 'dm-1' };
    mocks.params = { appId: 'gugu-assistant', tab: 'notes' };
    mocks.tabs = [{ kind: 'gugu-assistant.notes', enabled: true, extensionName: '咕咕助理', extensionId: 'gugu-assistant' }];
    expect(renderToStaticMarkup(<appView.TitlebarSlot />)).toContain('data-testid="app-page-open-in-window"');
    expect(renderToStaticMarkup(<appView.MainPanel />)).toContain(`padding-top:${WINDOW_CONTROL_BAR_HEIGHT_PX}px`);
    // Another App while the entry goes to the assistant App: its own page, as before.
    mocks.params = { appId: 'clock' };
    expect(renderToStaticMarkup(<appView.TitlebarSlot />)).toContain('>Clock</span>');
    expect(renderToStaticMarkup(<appView.MainPanel />)).toContain(`padding-top:${WINDOW_CONTROL_BAR_HEIGHT_PX}px`);
  });

  it('both places of the rail are drawn without the task list beside them', () => {
    expect(appView.withoutSessionSidebar).toBe(true);
    expect(appsView.withoutSessionSidebar).toBe(true);
  });
});
