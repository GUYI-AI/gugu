import { openFolderInTab } from '@renderer/features/sessions/file-view/file-view-kinds';
import { findSessionAnywhere } from '@renderer/features/sessions/stores/session-selectors';
import { composeChatDraft } from '@/lib/composeDraft';
import { followLink, openLinkTarget } from '@/lib/guguLinks';
import { readAppHostLayerBridge } from '@/lib/appHostLayerBridge';
import { toast } from '@renderer/lib/hooks/use-toast';
import { translateSessionMessage } from '@renderer/localization/locale-store';
import { rpc } from '@renderer/lib/ipc';
import { desktopIpc } from '@/platform/desktopIpc';
import { EXTENSION_BRIDGE_CHANNEL, type ExtensionBridgeResponse } from '@shared/extensions/bridge-protocol';
import type { AppModalHostAction } from '@shared/extensions/app-modal';
import type { BrowserWebviewElement } from '@renderer/features/browser/browser-webview-types';

import { runInAction } from 'mobx';
import type { RendererRpcHandlers } from '@/rpc-renderer/rendererRpc';
import type { WorkspaceViewModel } from '@renderer/features/sessions/stores/workspace-view-model';
import {
  EXTENSION_HOST_ACTION_METHOD,
  EXTENSION_INSTALL_CONSENT_CLOSE_METHOD,
  EXTENSION_INSTALL_CONSENT_METHOD,
  EXTENSION_INSTALLED_CHANGED_METHOD,
  EXTENSION_LISTED_SESSION_METHOD,
  EXTENSION_MEMBER_FACES_METHOD,
  EXTENSION_PICK_DISPATCH_TARGET_METHOD,
  EXTENSION_CONFIRM_RESOURCE_REMOVAL_METHOD,
  EXTENSION_TRANSCRIBE_VOICE_NOTE_METHOD,
  EXTENSION_EXPORT_VOICE_NOTE_METHOD,
  EXTENSION_VOICE_NOTE_METHOD,
  INSTALL_CONSENT_HUMAN_WINDOW_MS,
  type ResourceRemovalAsk,
  type VoiceNoteExportAsk,
  type VoiceNoteTranscribeAsk,
  type ExtensionHostAction,
  type ExtensionHostActionResult,
  type ExtensionHostActionCommand,
  type ExtensionInstallConsentRequest,
  type ExtensionInstallConsentResult,
} from '@shared/extensions/host-actions';
import {
  APP_FORWARD_FILES_EVENT,
  APP_OPEN_WITH_EVENT,
} from '@shared/extensions/app-runtime-protocol';
import type { DispatchAsk } from '@shared/extensions/app-dispatch-core';
import { openApp } from './app-dock';
import { installedExtensionsStore } from './installed-extensions-store';
import { safeParseExtensionManifest } from '@shared/extensions/manifest';
import { isAssistantLayerScreen } from '@shared/extensions/assistant-binding';
import { extensionSurfaceStore } from './extension-surface-store';
import { peekStore } from './peek-store';
import { screenLayout } from '@renderer/app/screen-layout';
import { focusScreenBlock } from '@renderer/app/screen-layout-actions';
import { appState } from '@renderer/lib/stores/app-state';
import { isEmbedVisible } from '@renderer/lib/portal-container';
import { askInShell, closeInShell, installConsentPrompt } from './install-consent';
import { revealSessionpage } from '@/hooks/useSessionpageReveal';
import { closeAppModal, focusAppModalClose, showAppModal } from '@/components/appModal/appModal';
import { groupPageSlot } from '@renderer/features/chats/chat-tabs/chat-panel-item';

/**
 * Performs the actions main has already decided an extension is allowed to take.
 *
 * Nothing here re-checks permission, and nothing here can be reached without
 * having passed main first: identity comes from the surface's session, which
 * only main can read. The renderer's job is the half main cannot do — it owns
 * the tab strip and the conversation. Refs #2374.
 *
 * Every handler throws on failure rather than returning quietly. The bridge
 * turns a throw into a failed call the extension can see, and 「做没做成」是扩展
 * 唯一能据以重试或提示用户的信息。
 */

/**
 * The task's view, found by scanning the mounted projects.
 *
 * Scanned rather than addressed because an action carries the task it came
 * from, not the project: the surface never knew the project id, and inventing a
 * way to tell it one would hand extensions a fact they have no use for.
 */
function findSessionView(sessionId: string): WorkspaceViewModel | undefined {
  return findSessionAnywhere(sessionId)?.viewModel;
}


function requireSessionView(sessionId: string | null): WorkspaceViewModel {
  const view = sessionId === null ? null : findSessionView(sessionId);
  if (!view) throw new Error('This session is no longer open');
  return view;
}

/** The block of the screen a session is drawn in, while that screen is what the person sees; null otherwise. */
function blockOnScreen(sessionId: string): string | null {
  if (!isEmbedVisible() || appState.navigation.currentViewId !== 'session') return null;
  return screenLayout.blockOfSession(sessionId) ?? null;
}

export function applyExtensionHostAction(command: ExtensionHostActionCommand): ExtensionHostActionResult | Promise<ExtensionHostActionResult> {
  const { origin, action } = command;
  // A link's or a banner's click has no page behind it: only what names its own target is done for it.
  if (!origin) return runInAction(() => openForClick(action));
  return runInAction(() => perform(origin.sessionId, origin.tabId, action, origin.extensionId));
}

function openForClick(action: ExtensionHostAction, fromTab?: string): ExtensionHostActionResult | Promise<ExtensionHostActionResult> {
  switch (action.kind) {
    case 'openApp':
      if (action.chatId) return openLinkTarget({ kind: 'app', extensionId: action.extensionId, tab: action.tab ?? installedExtensionsStore.mainTabOf(action.extensionId)?.kind.slice(action.extensionId.length + 1) ?? '', path: '', query: {}, place: { chat: action.chatId } });
      { const opened = openApp(action.extensionId, action.tab); revealSessionpage(); return opened; }
    case 'openChatFile':
      if (action.onlyIfOpen) return import('@renderer/features/chats/chat-tabs/chat-layouts').then(({ panelTabsOf, showChatTab }) => {
        const tabs = panelTabsOf(action.chatId);
        if (!tabs.some((entry) => entry.shown && !entry.inWindow && groupPageSlot(action.chatId, entry.tabId) === fromTab)) return;
        if (action.intent && action.intent !== 'navigate') return;
        const tab = tabs.find((entry) => !entry.inWindow && groupPageSlot(action.chatId, entry.tabId) === fromTab && entry.item.itemId === action.itemId && entry.item.kind === action.onlyIfOpen);
        if (!tab) return;
        showChatTab(action.chatId, tab.tabId);
        // The body is already there. The original metadata validation starts after presenting it.
        return new Promise<{ chat: string }>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve({ chat: action.chatId }))));
      });
      return openLinkTarget({ kind: 'file', itemId: action.itemId });
    case 'openLinkTarget':
      return openLinkTarget(action.target);
    case 'notGivenAt': {
      // The App's page in 「App」 is where a chat is added, one at a time (`changeAppPlaces`).
      const app = installedExtensionsStore.manifests.find((manifest) => manifest.id === action.extensionId)?.name ?? action.extensionId;
      toast({
        title: translateSessionMessage('extensions.notGivenAt', { app, chat: action.chat.name }),
        tier: 'warning',
        duration: 15_000,
        action: { label: translateSessionMessage('extensions.notGivenAtAction'), onClick: () => void followLink({ kind: 'app-detail', extensionId: action.extensionId }) },
      });
      return undefined;
    }
    default:
      throw new Error(`${action.kind} is a page's: no page asked for it`);
  }
}

function perform(sessionId: string | null, tabId: string, action: ExtensionHostAction, extensionId: string): ExtensionHostActionResult | Promise<ExtensionHostActionResult> {
  // What a page says about itself: a task's tab or a group's slot (sessionId null), kept by page (extensionSurfaceStore.say).
  switch (action.kind) {
    case 'taskMessage': {
      const target = sessionId === null ? undefined : findSessionAnywhere(sessionId);
      if (!target || !sessionId) throw new Error('This task is no longer open');
      return rpc.sessions.sendMessage({ projectId: target.projectId, sessionId, clientMessageId: crypto.randomUUID(), text: action.text })
        .then(result => { if (result.status === 'outcome-unknown') throw new Error('Task message delivery is unknown'); });
    }
    case 'navigateTab':
      if (action.delta !== -1 && action.delta !== 1) throw Object.assign(new Error('Navigation delta must be -1 or 1'), { code: 'invalid' });
      return (async () => {
        let sourceId = tabId;
        let pane = sessionId ? [...(findSessionView(sessionId)?.paneLayout.groups ?? []), ...(findSessionView(sessionId)?.paneLayout.windowPanes.values() ?? [])].find(({ pane }) => pane.entries.has(sourceId))?.pane : undefined;
        if (!sessionId) {
          const { chatPageOrigin } = await import('@renderer/features/chats/chat-tabs/chat-layouts');
          const source = chatPageOrigin(tabId);
          if (source) { sourceId = source.tabId; pane = source.pane; }
        }
        const entry = pane?.entries.get(sourceId);
        const kind = entry?.kind === 'chat-panel' ? (entry.state as { kind?: string })?.kind : entry?.kind;
        if (!kind?.startsWith(`${extensionId}.`)) return { navigated: false };
        const history = pane?.navigationOf(sourceId);
        const opener = pane?.openerOf(sourceId);
        const conversationBack = action.delta === -1 && !!opener && pane!.registry.has(opener.kind) && pane!.registry.get(opener.kind).conversation === true;
        if (!history?.pages[history.index + action.delta] && !conversationBack) return { navigated: false };
        return { navigated: await pane!.go(sourceId, action.delta) };
      })();
    case 'openAppModal': {
      let guest: BrowserWebviewElement | null = null;
      let previous = document.activeElement;
      while (previous?.shadowRoot?.activeElement) previous = previous.shadowRoot.activeElement;
      const control = async (action: AppModalHostAction) => {
        const response = await desktopIpc()!.invoke(EXTENSION_BRIDGE_CHANNEL, { method: 'modalHost', args: action }) as ExtensionBridgeResponse;
        if (!response.ok) throw new Error(response.message);
      };
      const dismiss = (error?: string) => control({ type: 'dismiss', id: action.page.id, ...(error ? { error } : {}) });
      const fail = (error: unknown) => dismiss(error instanceof Error ? error.message : String(error));
      const focus = async (edge: 'first' | 'last') => {
        guest?.focus();
        await control({ type: 'focus', id: action.page.id, edge });
      };
      showAppModal({
        id: action.page.id, title: action.page.title, appName: action.page.appName, size: action.page.size,
        url: action.page.entryUrl, partition: action.page.partition,
        opener: previous instanceof HTMLElement ? previous : document.body,
        focus, dismiss,
        attach(element) {
          guest = element as BrowserWebviewElement;
          let boundId: number | null = null;
          const report = () => {
            if (boundId !== null) void rpc.extensions.reportLayout({ webContentsId: boundId, visible: true, width: element.clientWidth, height: element.clientHeight }).catch(fail);
          };
          const observer = new ResizeObserver(report);
          observer.observe(element);
          const ready = () => {
            const webContentsId = (element as BrowserWebviewElement).getWebContentsId();
            void control({ type: 'bind', id: action.page.id, webContentsId }).then(() => {
              if (guest !== element) return;
              boundId = webContentsId; report(); return focus('first');
            }).catch((error: unknown) => { if (guest === element) void fail(error); });
          };
          const gone = () => void fail(new Error('The App modal content process exited'));
          const failed = (event: Event) => {
            const failure = event as Event & { errorCode?: number; errorDescription?: string };
            if (failure.errorCode !== -3) void fail(new Error(failure.errorDescription ?? 'The App modal page did not load'));
          };
          element.addEventListener('dom-ready', ready);
          element.addEventListener('render-process-gone', gone);
          element.addEventListener('did-fail-load', failed);
          return () => {
            observer.disconnect();
            element.removeEventListener('dom-ready', ready);
            element.removeEventListener('render-process-gone', gone);
            element.removeEventListener('did-fail-load', failed);
            guest = null;
          };
        },
      });
      return;
    }
    case 'closeAppModal':
      closeAppModal(action.id);
      return;
    case 'focusAppModalClose':
      focusAppModalClose(action.id);
      return;
    case 'setTabTitle':
      extensionSurfaceStore.say(sessionId, tabId, { title: action.title });
      return;
    case 'setTabBadge':
      extensionSurfaceStore.say(sessionId, tabId, { badge: action.badge });
      return;
    case 'setTabDirty':
      extensionSurfaceStore.reportDirty(sessionId, action.tabId, action.dirty, action.webContentsId);
      return;
    case 'reportError':
      extensionSurfaceStore.say(sessionId, tabId, { error: action.message });
      return;
    case 'newDocument':
      extensionSurfaceStore.say(sessionId, tabId, { title: null, badge: null, error: null });
      extensionSurfaceStore.clearDirtyOfPage(sessionId);
      // #1925 A host page or the assistant's figure that page asked for over its panel goes with the old document.
      void import('../apps/app-host-layer').then(({ appPageNewDocument, pageKey }) => appPageNewDocument(extensionId, pageKey(sessionId, tabId)), () => undefined);
      return;
    case 'openBrowserTab': {
      const view = requireSessionView(sessionId);
      view.showPage(action.url, { reload: false, from: tabId });
      view.setFocusedRegion('main');
      return;
    }
    case 'compose': {
      // A chat's: the chat shell takes it (MainLayout: its draft, the chat brought up), as the phone's page gives it.
      if ('detail' in action) {
        // Capture flushes pending typing before the shell appends during bubbling.
        composeChatDraft(action.detail);
        return;
      }
      // A session's: main brought it on screen; its composer takes the text once its conversation is open there.
      const target = action.sessionId;
      return import('./compose-in-session').then(({ composeWhenOpen }) => composeWhenOpen(() => findSessionView(target), action.text));
    }
    // #1925 main checked the page is drawn beside its bound conversation: its own panel there, collapsed or expanded.
    case 'conversationPanel':
      return import('@renderer/features/apps/app-conversation-panel').then(({ setAppConversationPanelCollapsed }) => {
        // #1927 (48) An intent is about to be told to the App's page: nothing of the host's stays over it (as the row's profile).
        if (action.uncover) readAppHostLayerBridge()?.close(extensionId);
        setAppConversationPanelCollapsed(extensionId, action.collapsed);
      });
    // #1925 (46) Main checked the account, the grant, the assistant's chat and the row: the shell draws that task in the App's
    // panel, or takes it away. The shell's bridge refuses an account or a row it does not have now.
    case 'openWork':
    case 'closeWork': {
      // #1925 (46) The host page over the App's panel (lib/appHostLayerBridge.ts): opening a task replaces any page there;
      // closing takes away a task only, never another host page the person opened.
      const bridge = readAppHostLayerBridge();
      if (!bridge) throw new Error('This window draws no host pages over an App');
      if (action.kind === 'closeWork') return bridge.close(extensionId, 'work');
      return bridge.open(extensionId, { kind: 'work', ownerId: action.ownerId, workId: action.workId, sessionId: action.sessionId });
    }
    // The chat shell takes them (MainLayout: another chat comes up first), as the phone's page gives them.
    case 'showMessage':
      return openLinkTarget({ kind: 'chat', chatId: action.detail.chatId, messageId: action.detail.messageId });
    case 'openWith':
      if (action.detail.background) return import('@renderer/features/chats/chat-tabs/chat-layouts').then(({ updateFileNames }) => {
        const detail = action.detail;
        updateFileNames([{ id: detail.itemId, filename: detail.name, content_type: detail.file.contentType }], installedExtensionsStore.manifests);
      });
      return import('@renderer/features/chats/chat-tabs/chat-layouts').then(({ panelTabsOf, chatPaneOf }) => {
        const from = panelTabsOf(action.detail.chatId).find((tab) => groupPageSlot(action.detail.chatId, tab.tabId) === tabId)?.tabId;
        if (from && action.detail.viewState) chatPaneOf(action.detail.chatId, from)?.setPageViewState(from, action.detail.viewState);
        window.dispatchEvent(new CustomEvent(APP_OPEN_WITH_EVENT, { detail: { ...action.detail, from } }));
      });
    // An App's 「用 X 打开」 on a session's working-copy file: in that session's pane, by the resolver a click there goes
    // through (`openFileInSessionEditor`) — the same for a session on this computer and one on another.
    case 'openSessionFile': {
      return (async () => {
        if (!action.projectId) throw new Error('This session has no known project');
        const { machineCodec } = await import('@renderer/lib/machine-routing');
        const projectId = action.deviceId ? machineCodec(action.deviceId).inbound(action.projectId) : action.projectId;
        const { prepareSessionPane } = await import('@renderer/features/sessions/session-pane-ready');
        await prepareSessionPane(projectId, action.sessionId);
        if (!findSessionAnywhere(action.sessionId)) throw new Error('This session has no prepared pane');
        const { openFileInSessionEditor } = await import('@renderer/features/sessions/stores/open-file-in-file-editor');
        if (sessionId === action.sessionId && action.viewState) {
          const pane = findSessionView(sessionId)?.paneLayout.groups.find(({ pane }) => pane.entries.has(tabId))?.pane;
          pane?.setPageViewState(tabId, action.viewState);
        }
        // The person cancelled 「用哪个打开」: nothing opens, and nothing went wrong.
        await openFileInSessionEditor(projectId, action.sessionId, action.path, { ask: action.ask, intent: action.intent, byHost: true, ...(sessionId === action.sessionId ? { from: tabId } : {}) });
      })();
    }
    case 'openSessionFolder': {
      const view = sessionId ? findSessionView(sessionId) : undefined;
      if (!view) throw new Error('This session has no prepared pane');
      openFolderInTab(view.paneLayout, tabId, action.folder);
      return;
    }
    case 'forwardFiles':
      window.dispatchEvent(new CustomEvent(APP_FORWARD_FILES_EVENT, { detail: action.detail }));
      return;
    // Beside the page that asked, in the slot it is drawn in: that slot draws it (AppPeekSlot). A session already in a
    // block on screen is not drawn twice: that block is looked at instead (one session, one place — ScreenArea).
    case 'peek': {
      const block = action.target.kind === 'session' ? blockOnScreen(action.target.sessionId) : null;
      if (block) return focusScreenBlock(block);
      peekStore.open(sessionId, tabId, action.target);
      return;
    }
    case 'openApp':
    case 'openChatFile':
    case 'openLinkTarget':
      return openForClick(action, tabId);
    // #1925 The assistant's own screens, each by its existing entry; and the setup steps an App draws, moved on.
    case 'openAssistantScreen':
      // The panel's own pages go over this App's panel (its host layer); the rest are the shell's screens.
      if (isAssistantLayerScreen(action.screen)) {
        const screen = action.screen;
        return import('../apps/app-host-layer').then(({ openAssistantLayer, pageKey }) => openAssistantLayer(extensionId, screen, action.ownerId, pageKey(sessionId, tabId)));
      }
      return import('@/lib/assistantAppHost').then(({ openAssistantScreen }) => openAssistantScreen(action.screen, action.ownerId));
    case 'advanceAssistantSetup':
      return import('@/lib/assistantAppHost').then(({ advanceAssistantSetup }) => advanceAssistantSetup(action.next, action.ownerId));
    case 'renameAssistant':
      return import('@/lib/assistantAppHost').then(({ renameAssistantFor }) => renameAssistantFor(action.text, action.ownerId));
    case 'assistantFigure': {
      const { figure, ownerId, who } = action;
      return import('../apps/app-host-layer').then(({ setAssistantFigure, pageKey }) => setAssistantFigure(extensionId, figure && ownerId ? { figure, ownerId, who, from: pageKey(sessionId, tabId) } : null));
    }
    case 'openAssistantConnector':
      return import('../apps/assistant-app-counts').then(({ openAssistantConnector }) => openAssistantConnector(action.id, action.ownerId));
    case 'toast':
      // The host's own toast, as the built-in 「更改已保存」: the text alone.
      toast({ title: action.text });
      return;
  }
}

export const extensionHostActionHandlers: RendererRpcHandlers = {
  [EXTENSION_HOST_ACTION_METHOD]: async (params: unknown) => {
    const opened = await applyExtensionHostAction(params as ExtensionHostActionCommand);
    return { ok: true, opened };
  },
  /**
   * 已装的集合变了 —— 重新登记 tab,新装的扩展这才在 tab 栏里出现。
   *
   * 动态 import 与 open-file-in-file-editor 那处同因:把 register-extension-tabs 的模块图静态拉进
   * 这份 handler,等于把它塞进每一条走 extensions 通道的路径。❌ 别改成顶层 import。
   */
  [EXTENSION_INSTALLED_CHANGED_METHOD]: async (): Promise<{ ok: true }> => {
    const { registerInstalledExtensionTabs } = await import('./register-extension-tabs');
    await registerInstalledExtensionTabs();
    // What the market has to say is about what is installed: an App updated by itself (auto-update-apps.ts) has no update now.
    const { installedExtensionsStore } = await import('./installed-extensions-store');
    void installedExtensionsStore.checkUpdates();
    return { ok: true };
  },
  /** Members' faces (`lib/memberFaces.ts`). Imported when asked, as above. */
  [EXTENSION_MEMBER_FACES_METHOD]: async (params: unknown): Promise<Record<string, string>> => {
    const people = (params as { people?: unknown } | null)?.people;
    if (!Array.isArray(people)) throw new Error('Invalid member faces request');
    const { memberFaces } = await import('@/lib/memberFaces');
    return memberFaces(people as { id: string; avatar: string | null }[]);
  },
  /**
   * #7158 `gugu.showSession` for a session not on this computer: the project the task list has it under, or null when
   * the list has none. Only an answer — main brings it up the one way a banner's click does. Imported when asked, as above.
   */
  [EXTENSION_LISTED_SESSION_METHOD]: async (params: unknown): Promise<string | null> => {
    const { sessionId, deviceId, projectId } = (params ?? {}) as { sessionId?: unknown; deviceId?: unknown; projectId?: unknown };
    if (typeof sessionId !== 'string') throw new Error('Invalid listed session request');
    const { remoteHostsStore } = await import('@renderer/features/remote-hosts/remote-hosts-store');
    const listed = remoteHostsStore.listedProject(sessionId);
    if (listed || typeof deviceId !== 'string') return listed;
    return remoteHostsStore.reachProject(sessionId, deviceId, typeof projectId === 'string' ? projectId : undefined);
  },
  /** `gugu.dispatch` naming no target: the person picks one in the shell's sheet (DispatchSheet). */
  /**
   * #1927 (47) `gugu.voiceNote`: main has checked the App's grant; the recorder here checks its own account and assistant
   * (app-voice-note-host.ts). Imported when asked, as above: until an App asks, the recorder's App half is not loaded.
   */
  [EXTENSION_VOICE_NOTE_METHOD]: async (params: unknown) => {
    const request = params as import('@shared/extensions/voice-note-session').VoiceNoteWindowRequest | null;
    if (!request || typeof request !== 'object' || typeof request.op !== 'string') throw new Error('Invalid voice note request');
    const { appVoiceNoteRequest } = await import('@renderer/features/assistant/voice-notes/app-voice-note-host');
    return appVoiceNoteRequest(request);
  },
  [EXTENSION_PICK_DISPATCH_TARGET_METHOD]: async (params: unknown) => {
    const { pickDispatchTarget } = await import('@/components/chat/dispatchAsk');
    return pickDispatchTarget(params as DispatchAsk);
  },
  /** #50 An App's managing calls: the assistant page's own question, 开始转写 and 导出 Markdown, in this window. */
  [EXTENSION_CONFIRM_RESOURCE_REMOVAL_METHOD]: async (params: unknown) => {
    const { resourceWindow } = await import('@renderer/features/assistant/voice-notes/app-resource-window');
    return resourceWindow().confirmRemoval(params as ResourceRemovalAsk);
  },
  [EXTENSION_TRANSCRIBE_VOICE_NOTE_METHOD]: async (params: unknown) => {
    const { resourceWindow } = await import('@renderer/features/assistant/voice-notes/app-resource-window');
    return resourceWindow().transcribe(params as VoiceNoteTranscribeAsk);
  },
  [EXTENSION_EXPORT_VOICE_NOTE_METHOD]: async (params: unknown) => {
    const { resourceWindow } = await import('@renderer/features/assistant/voice-notes/app-resource-window');
    return resourceWindow().exportNote(params as VoiceNoteExportAsk);
  },
  [EXTENSION_INSTALL_CONSENT_METHOD]: (params: unknown): Promise<ExtensionInstallConsentResult> => {
    if (!params || typeof params !== 'object') throw new Error('Invalid extension consent request');
    const request = params as ExtensionInstallConsentRequest;
    if (typeof request.sourceDir !== 'string' || typeof request.manifestDigest !== 'string') {
      throw new Error('Invalid extension consent request');
    }
    const parsed = safeParseExtensionManifest(request.manifest);
    if (!parsed.ok) throw new Error('Invalid extension consent manifest');

    const requestId = request.requestId ?? `${request.manifestDigest}:${Date.now()}`;
    // The same words and the same sheet as the phone's own installs (install-consent.ts).
    const prompt = installConsentPrompt(request, parsed.manifest);
    const inShell = askInShell(prompt, requestId, INSTALL_CONSENT_HUMAN_WINDOW_MS, request.given, request.requester, request.machine);
    // The shell (MainLayout) draws it on the desktop and the phone alike; there is no second way (D-31: the 「切到任务页再弹」
    // fallback is gone — it switched the person's view, the one thing F6 asked never to do).
    if (!inShell) throw new Error('No consent sheet in this window to ask the person with');
    return inShell;
  },
  /** D-31 The ask was answered on another surface, or ran out: this window's sheet for it goes. */
  [EXTENSION_INSTALL_CONSENT_CLOSE_METHOD]: (params: unknown): { ok: true } => {
    const requestId = (params as { requestId?: unknown } | null)?.requestId;
    if (typeof requestId !== 'string') throw new Error('Invalid extension consent close');
    closeInShell(requestId);
    return { ok: true };
  },
};
