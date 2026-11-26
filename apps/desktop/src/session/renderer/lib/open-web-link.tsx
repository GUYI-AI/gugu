import { messageForUser } from '@/lib/userFacingError';
import { log } from '@renderer/utils/logger';
import { getSessionView } from '@renderer/features/sessions/stores/session-selectors';
import type { PaneStore } from '@renderer/features/tabs/pane-store';
import { toast } from '@renderer/lib/hooks/use-toast';
import { rpc } from '@renderer/lib/ipc';
import { appState } from '@renderer/lib/stores/app-state';
import { translateSessionMessage } from '@renderer/localization/locale-store';
import { normalizeExternalHttpUrl } from './external-url';
import { activeRemoteLinkTarget } from './remote-link-target';

const HTTP_URL_PATTERN = /^https?:\/\//i;

/** Where a person sends a web link: Gugu's own browser, or the system's. */
export type WebLinkTarget = 'app' | 'system';

/** A plain click opens in Gugu's browser; Cmd/Ctrl-click opens in the system browser. */
export function webLinkTarget(click?: { metaKey?: boolean; ctrlKey?: boolean }): WebLinkTarget {
  return click?.metaKey || click?.ctrlKey ? 'system' : 'app';
}

/**
 * @@@open-web-link — the one place that opens a web link a person clicked or chose from a link menu, from every surface
 * (chat and task messages, file previews, terminals, App product pages, the host's link menus). `pane` is the pane the
 * link was in; without one it opens beside the session being looked at. Nowhere to open it in Gugu ⇒ the system browser.
 * Returns false for anything that is not an http(s) link: those keep their own openers.
 */
export function openWebLink(
  url: string,
  target: WebLinkTarget,
  pane?: PaneStore | null,
  intent: 'beside' | 'newTab' | 'navigate' = 'beside',
): boolean {
  const normalizedUrl = normalizeExternalHttpUrl(url);
  if (!HTTP_URL_PATTERN.test(normalizedUrl)) return false;
  if (target === 'system') {
    openExternalLinkInBrowser(normalizedUrl);
    return true;
  }
  // #6264 别的机器上的会话里点的 localhost 链接:开进那条会话的浏览器格(经 SSH 转到那台机器),❌ 开到这台电脑自己的端口。
  const remote = activeRemoteLinkTarget();
  if (remote?.claimLoopback(normalizedUrl)) return true;
  const into = pane ?? getActiveSessionView()?.activePane;
  if (into) into.open('browser', { initialUrl: normalizedUrl }, { intent });
  else if (remote?.canOpenInBrowserTab) remote.openInBrowserTab(normalizedUrl);
  else openExternalLinkInBrowser(normalizedUrl);
  return true;
}

/** The system browser, with a toast when the system refuses. */
export function openExternalLinkInBrowser(url: string, onError?: (error: unknown) => void): void {
  const normalizedUrl = normalizeExternalHttpUrl(url);
  if (!HTTP_URL_PATTERN.test(normalizedUrl)) return;
  void rpc.app.openExternal(normalizedUrl).catch((error) => {
    log.error('opening an external link failed', { error });
    toast({ title: translateSessionMessage('externalLink.openFailed'), description: messageForUser(error), tier: 'error' });
    onError?.(error);
  });
}

export async function copyExternalLink(url: string, done = translateSessionMessage('externalLink.linkCopied')): Promise<boolean> {
  try {
    await rpc.app.clipboardWriteText(url);
    toast({ title: done });
    return true;
  } catch (error) {
    log.error('clipboard copy failed', { error });
    toast({ title: translateSessionMessage('externalLink.copyFailed'), description: messageForUser(error), variant: 'destructive' });
    return false;
  }
}

function getActiveSessionView() {
  if (appState.navigation.currentViewId !== 'session') return undefined;
  const params = appState.navigation.viewParamsStore.session;
  const projectId = typeof params?.projectId === 'string' ? params.projectId : undefined;
  const sessionId = typeof params?.sessionId === 'string' ? params.sessionId : undefined;
  if (!projectId || !sessionId) return undefined;
  return getSessionView(projectId, sessionId);
}
