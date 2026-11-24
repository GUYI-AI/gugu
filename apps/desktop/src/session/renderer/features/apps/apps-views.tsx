import type { AgentAppDetailLink } from '@gugu/core/shared/ui/guguLink';
import { retryOf } from '@/lib/replica';
import { action, observable } from 'mobx';
import { observer } from 'mobx-react-lite';
import { AppErrorDetails, AppErrorMark } from '@/components/appSlot/AppErrorMark';
import { WINDOW_CONTROL_BAR_HEIGHT_PX } from '@/lib/window-chrome';
import { useContext, useState, type ReactElement, type ReactNode } from 'react';
import type { ViewDefinition } from '@renderer/app/view-registry';
import { SquareArrowOutUpRight, Settings } from '@/lib/icons';
import { followLink } from '@/lib/guguLinks';
import { useAssistantEntryTarget } from '@/lib/assistantEntry';
import { openAppInWindow } from '@renderer/features/extensions/app-dock';
import { AppConversationFrame } from './app-conversation-frame';
import { AppHostLayerFrame } from './app-host-layer';
import { useAssistantPageNotHere } from './assistant-page-not-here';
import { extensionSurfaceStore, extensionTabTitle } from '@renderer/features/extensions/extension-surface-store';
import { LOCAL_HOST, useInstalledApps, type InstalledApps } from '@renderer/features/extensions/installed-extensions';
import { Unknown } from '@/components/ui/Unknown';
import { reloadAppPage } from '@renderer/features/extensions/app-page-unsaved';
import { ExtensionsLibraryPage } from '@renderer/features/library/extensions-library-page';
import { LibraryHostProvider, LOCAL_LIBRARY_HOST, machineLibraryHost } from '@renderer/features/library/library-host';
import { TabBarActionRow } from '@renderer/features/sessions/titlebar-actions';
import { PageContent, PageLayout } from '@renderer/lib/components/page-layout';
import { PageModalClose, ShellTitlebar } from '@renderer/lib/components/titlebar/shell-titlebar';
import { MODAL_HEADER_H, MODAL_TITLE } from '@/components/ui/modalGeometry';
import { useNavigate, useParams } from '@renderer/lib/layout/navigation-provider';
import { appState } from '@renderer/lib/stores/app-state';
import { navigateBack } from '@renderer/lib/components/nav-buttons';
import { remoteHostsStore } from '@renderer/features/remote-hosts/remote-hosts-store';
import { createExtensionOperations, ExtensionOperationsContext } from '@renderer/features/extensions/panel/extension-pending';
import { InstalledManager } from '@renderer/features/extensions/installed/InstalledManager';
import { appsLocation, currentAppsLocation, moveAppsLocation, previousAppsLocation, type AppsLocation } from './apps-location';
import { AgentAppDetailDialog } from './agent-app-detail-dialog';
import { restoreAgentDetailComposer } from './agent-app-detail-navigation';
import { Button } from '@renderer/lib/ui/button';
import { useSessionMessages } from '@renderer/localization/use-session-messages';

const AppsMainPanel = observer(function AppsMainPanel(): ReactElement {
  const { params, setParams } = useParams('apps');
  const { navigate } = useNavigate();
  const { agentDetail, agentDetailFrom } = params;
  const location = appsLocation(params);
  const marketHost = location.deviceId ? deviceDetailHost(location.deviceId) : LOCAL_LIBRARY_HOST;
  const installed = location.installed;
  const [operations] = useState(createExtensionOperations);

  const closeAgentDetail = () => {
    if (agentDetailFrom !== 'apps' && appState.history.canGoBack) {
      navigateBack(true);
    } else {
      setParams({ agentDetail: undefined, agentDetailFrom: undefined });
    }
    if (agentDetailFrom === 'embedded-composer') restoreAgentDetailComposer();
  };

  return (
    <>
      <div className="contents">
        <PageLayout wide>
          <PageContent className="max-w-none px-0">
            <ExtensionOperationsContext.Provider value={operations}>
              <LibraryHostProvider value={marketHost} key={marketHost.key}>
                <ExtensionsLibraryPage
                  onOpenAgentDetail={(agentId) => setParams({
                    agentDetail: { kind: 'agent-app-detail', agentId, ...(marketHost.remote && { deviceId: marketHost.remote.deviceId }) },
                    agentDetailFrom: 'apps',
                  })}
                  installedPage={installed && <InstalledManager place={installed}
                    section={location.tab === 'market' ? 'apps' : location.tab}
                    onPlace={(next) => moveAppsLocation((here) => ({ ...here, installed: next }))}
                    onOpenAgent={(agentId, deviceId) => { void followLink({ kind: 'agent-app-detail', agentId, deviceId }); }}
                    onOpenApp={(extensionId, deviceId) => { void followLink({ kind: 'app-detail', extensionId, deviceId }); }} />}
                />
              </LibraryHostProvider>
            </ExtensionOperationsContext.Provider>
          </PageContent>
        </PageLayout>
      </div>
      {agentDetail && (
        <AgentDetailHost key={`${agentDetail.deviceId ?? 'local'}:${agentDetail.agentId}`} target={agentDetail}>
          <AgentAppDetailDialog
            agentId={agentDetail.agentId}
            onClose={closeAgentDetail}
            onCreate={() => {
              setParams({ agentDetail: undefined, agentDetailFrom: undefined });
              navigate('new-session', { agentId: agentDetail.agentId, deviceId: agentDetail.deviceId });
            }}
          />
        </AgentDetailHost>
      )}
    </>
  );
});

function deviceDetailHost(deviceId: string) {
  const device = remoteHostsStore.device(deviceId);
  return machineLibraryHost({
    deviceId,
    deviceLabel: device?.label ?? deviceId,
    online: device?.isOnline ?? false,
    lastSeenAt: device?.lastSeenAt ?? null,
    hostKind: device?.hostKind,
  });
}

const AgentDetailHost = observer(function AgentDetailHost({ target, children }: {
  target: AgentAppDetailLink;
  children: ReactNode;
}) {
  const host = target.deviceId ? deviceDetailHost(target.deviceId) : LOCAL_LIBRARY_HOST;
  return <LibraryHostProvider value={host}>{children}</LibraryHostProvider>;
});

type AppsViewParams = {
  location?: AppsLocation;
  agentDetail?: AgentAppDetailLink;
  agentDetailFrom?: 'apps' | 'embedded-composer';
};
function AppsViewWrapper({ children }: { children: ReactNode } & AppsViewParams) { return <>{children}</>; }

export const appsView = {
  WrapView: AppsViewWrapper,
  placeParams: ['location'],
  transientParams: ['agentDetail', 'agentDetailFrom'],
  TitlebarSlot: ShellTitlebar,
  MainPanel: AppsMainPanel,
  modal: true,
  onModalEscape: () => {
    if (!currentAppsLocation().detail || !previousAppsLocation()) return false;
    navigateBack(true);
    return true;
  },
} satisfies ViewDefinition<AppsViewParams>;

type AppViewParams = { appId?: string; tab?: string };

/** Draws nothing: a view's params are typed from its WrapView's props (`WrapParams`), so `useParams('app')` knows appId. */
function AppViewWrapper({ children }: { children: ReactNode } & AppViewParams) {
  return <>{children}</>;
}

/**
 * The App page's error, as a chat's panel shows it (125 10-06): the mark in the title row beside the name, the whole of
 * it under that row when pressed. A notify or link naming no place opens this page, so it is a place like the others.
 * The two halves are drawn by the title bar and the main panel, so whether it is open is kept here, per App.
 */
const errorDetailsShown = observable.set<string>();
const toggleErrorDetails = action((kind: string) => {
  if (!errorDetailsShown.delete(kind)) errorDetailsShown.add(kind);
});
const pageError = () => extensionSurfaceStore.said(null, 'dock').error;

/**
 * The App's main page is the assistant's page now (entry switch, lib/assistantEntry.ts): the trusted assistant App, its main
 * page beside the person's own assistant chat, where the rail's top cell goes. Drawn as the built-in assistant page was: no
 * title of its own (name, settings, open in window) and no band kept for one; the conversation and the panel start at the
 * top of the main area. Opened any other way in this window it is the same place (the rail lights its top cell), so the
 * same; its other tabs, and the App when the entry does not go to it, keep the App page's title bar.
 */
function useShownAsAssistant(appId: string | undefined, tab: string | undefined): boolean {
  const target = useAssistantEntryTarget();
  return target.kind === 'app' && !!appId && target.extensionId === appId && !tab;
}

function pageOf(apps: InstalledApps, appId: string | undefined, tab: string | undefined) {
  return tab ? apps.allTabContributions.find((entry) => entry.extensionId === appId && entry.kind === `${appId}.${tab}`) ?? null : appId ? apps.mainTabOf(appId) : null;
}

/**
 * 整页的顶栏:左边它的名字,右上角 ⧉ = 在新窗口打开(原型「它整页右上角 ⧉ = 窗口」)。⧉ 作用于这一页的内容,
 * 跟着内容走、贴窗口右缘(这页没有工作区面板那一簇),几何交给 <TabBarActionRow>,❌ 自己写 right-*。
 */
const AppTitlebar = observer(function AppTitlebar() {
  const { translate } = useSessionMessages();
  const { params } = useParams('app');
  const installed = useInstalledApps(LOCAL_HOST);
  const main = installed.state === 'value' ? pageOf(installed.value, params.appId, params.tab) : null;
  const error = main ? pageError() : null;
  const heading = main ? extensionTabTitle(extensionSurfaceStore.said(null, 'dock'), main.extensionName) : null;
  const openInWindowLabel = translate('tabs.openInWindow');
  const assistantPage = useShownAsAssistant(params.appId, params.tab);
  // In a modal its name is the modal's title, as Settings' is (@@@page-modal-close).
  const inModal = useContext(PageModalClose) !== null;
  // The assistant's page: nothing of the App's on the band but a reported error's mark. Its page starts at the top, under
  // this band, so the band is not the window's handle while the page is drawn (a drag band over the App's webview takes
  // real clicks on its tabs, owner 11-12): the conversation's column carries the handle (AppConversationFrame `windowHandle`).
  // ❌ an empty band then a name.
  if (installed.state === 'unknown' && !assistantPage) {
    return <ShellTitlebar leftSlot={<Unknown className="h-4 w-24" />} />;
  }
  if (assistantPage) {
    return <ShellTitlebar dragRegion={!main?.enabled} leftSlot={main && error ? <AppErrorMark error={error} onToggle={() => toggleErrorDetails(main.kind)} testId="app-page-error" /> : null} />;
  }
  return (
    <ShellTitlebar
      leftSlot={
        main ? (
          <span className="flex min-w-0 items-center gap-1">
            <span className="text-sm font-medium" style={inModal ? MODAL_TITLE : undefined} title={heading?.tooltip}>{heading?.label}</span>
            {error ? <AppErrorMark error={error} onToggle={() => toggleErrorDetails(main.kind)} testId="app-page-error" /> : null}
          </span>
        ) : null
      }
    >
      {main?.enabled && params.appId ? (
        <div className="absolute top-0 right-0 flex" style={{ height: WINDOW_CONTROL_BAR_HEIGHT_PX }}>
          <TabBarActionRow>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={translate('extensions.appSettings')}
              title={translate('extensions.appSettings')}
              onClick={() => params.appId && void followLink({ kind: 'app-detail', extensionId: params.appId, fromApp: true })}
              data-testid="app-page-settings"
            >
              <Settings />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={openInWindowLabel}
              title={openInWindowLabel}
              onClick={() => params.appId && openAppInWindow(params.appId)}
              data-testid="app-page-open-in-window"
            >
              <SquareArrowOutUpRight />
            </Button>
          </TabBarActionRow>
        </div>
      ) : null}
    </ShellTitlebar>
  );
});

/**
 * An App pinned to the rail, opened from it: its page of its own, filling the main area — the same live page a session's
 * tab shows, moved here, not a second one; leaving gives it back (the claims stack). Here it sits nowhere (真源原则 13):
 * no session, no chat in its context; what the person is looking at is `getAppState()`'s, and every call names its target.
 */
const AppMainPanel = observer(function AppMainPanel() {
  const { translate } = useSessionMessages();
  const { params } = useParams('app');
  const installed = useInstalledApps(LOCAL_HOST);
  const main = installed.state === 'value' ? pageOf(installed.value, params.appId, params.tab) : null;
  const error = main?.enabled ? pageError() : null;
  // The title bar is a zero-height band over the top of the main area (the App's name, the window's handle): the page
  // starts under it, as a session's tabs do (tab-bar.tsx) — an App drawing from its top edge sat beneath its own name
  // (125 10-06), and so did the line a switched-off App gets. Inline: tokens.css's `*{padding:0}` wipes utilities
  // outside the skinned shell. The assistant's page has no title there: it starts at the top, as the built-in page did.
  const assistantPage = useShownAsAssistant(params.appId, params.tab);
  // The assistant App not here yet (restored while it is being put in, or switched off): the page says it is getting ready, never
  // that the App is switched off, and gives way to the assistant's chat (assistant-page-not-here.ts).
  const assistantNotHere = useAssistantPageNotHere(params.appId, !!main?.enabled);
  // In a modal the title band is the modal's header, as tall as Settings' (@@@page-modal-close).
  const inModal = useContext(PageModalClose) !== null;
  return (
    <div className="flex h-full min-h-0 w-full flex-col" style={assistantPage ? undefined : { paddingTop: inModal ? MODAL_HEADER_H : WINDOW_CONTROL_BAR_HEIGHT_PX }} data-testid="app-page" data-assistant-page={assistantPage ? '' : undefined}>
      {installed.state === 'unknown' ? (
        // ❌ 「已停用」 before the list says so.
        <div className="min-h-0 flex-1" data-testid="app-page-unknown" aria-busy="true" />
      ) : installed.state === 'error' ? (
        <div className="flex flex-col items-start gap-2 text-sm text-foreground-muted" style={{ padding: 24 }} data-testid="app-page-unreadable">
          <p>{translate('extensions.loadFailed')}</p>
          <Button variant="outline" size="sm" onClick={retryOf(installed)}>{translate('common.retry')}</Button>
        </div>
      ) : !main?.enabled ? (
        <p className="text-sm text-foreground-muted" style={{ padding: 24 }}>{translate(assistantNotHere ? 'extensions.assistantPreparing' : 'extensions.turnOnInSettings')}</p>
      ) : (
        <>
          {error && errorDetailsShown.has(main.kind) ? <AppErrorDetails error={error} testId="app-page-error-details" onReload={() => void reloadAppPage(null, 'dock')} /> : null}
          {/* #1925 Its main page placed beside its bound conversation: the conversation's frame, while the host may draw it. */}
          {/* #1925 (44, 46) Elsewhere its page stands alone; a host page over it (a task, the assistant's own pages) in its place. */}
          {placedBesideConversation(installed.value, main) ? <AppConversationFrame extensionId={main.extensionId} tabKind={main.kind} windowHandle={assistantPage} /> : <AppHostLayerFrame extensionId={main.extensionId} tabKind={main.kind} />}
        </>
      )}
    </div>
  );
});

/** The App's main page — not another of its tabs — and the App declares it beside its conversation binding (#1925). */
function placedBesideConversation(apps: InstalledApps, page: { extensionId: string; kind: string }): boolean {
  return apps.mainTabOf(page.extensionId)?.kind === page.kind
    && !!apps.manifestFor(page.extensionId)?.contributes.conversationSurface;
}

export const appView = {
  WrapView: AppViewWrapper,
  TitlebarSlot: AppTitlebar,
  MainPanel: AppMainPanel,
  modal: true,
} satisfies ViewDefinition<AppViewParams>;
