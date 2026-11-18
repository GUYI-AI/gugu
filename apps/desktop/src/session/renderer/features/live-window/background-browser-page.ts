import type { BrowserState } from '../browser/browser-tab-provider';
import type { BrowserTabResource } from '../browser/browser-tab-resource';
import type { WorkspaceViewModel } from '../sessions/stores/workspace-view-model';
import type { TabEntry } from '../tabs/core/tab-provider';
import { rpc } from '@renderer/lib/ipc';

type BackingPage = { state: BrowserState; resource: BrowserTabResource; preparing: number; prepared: boolean };
const pages = new WeakMap<WorkspaceViewModel, BackingPage>();

/** Browser Use's real page can live behind its mapped picture without creating a second visible pane. */
export async function acquireBackgroundBrowserPage(view: WorkspaceViewModel, url: string): Promise<BackingPage> {
  const existing = pages.get(view); if (existing) return existing;
  const { browserTabProvider } = await import('../browser/browser-tab-provider');
  const raced = pages.get(view); if (raced) return raced;
  const state = browserTabProvider.onBeforeOpen!({ initialUrl: url }, view.activePane.ctx);
  if (!state) throw new Error('The task browser page could not be created');
  const entry: TabEntry<BrowserState> = { kind: 'browser', tabId: `task-browser:${state.browserId}`, state };
  const resource = browserTabProvider.initialize(entry, {
    tabId: entry.tabId,
    close: async () => { releaseBackgroundBrowserPage(view); return true; },
    open: (kind, args, config) => { view.paneLayout.open(kind, args, { from: null, intent: 'newTab', ...config }); },
  }, view.activePane.ctx);
  const page = { state, resource, preparing: 0, prepared: false }; pages.set(view, page); return page;
}
export function backgroundBrowserPage(view: WorkspaceViewModel) { return pages.get(view); }
export function releaseBackgroundBrowserPage(view: WorkspaceViewModel): void {
  const page = pages.get(view); if (!page) return;
  pages.delete(view); page.resource.dispose();
}
export async function prepareBackgroundBrowserPage(view: WorkspaceViewModel, url: string,
  request: { createIfMissing: boolean; deadline: number }, signal: AbortSignal) {
  const check = () => { signal.throwIfAborted(); if (Date.now() >= request.deadline) throw new Error('timed out restoring the session browser page'); };
  check();
  const backing = backgroundBrowserPage(view);
  if (!backing && !request.createIfMissing) throw new Error('This session has no browser page. Use browser_navigate with a URL first.');
  const page = backing ?? await acquireBackgroundBrowserPage(view, url);
  page.preparing++;
  let ended = false;
  const end = (success = false) => {
    if (ended) return; ended = true; page.preparing--; if (success) page.prepared = true;
    if (!page.prepared && page.preparing === 0 && pages.get(view) === page) releaseBackgroundBrowserPage(view);
  };
  const rollback = () => end();
  signal.addEventListener('abort', rollback, { once: true });
  const timer = setTimeout(rollback, Math.max(0, request.deadline - Date.now()));
  try {
    check(); const snapshot = page.resource.session;
    if (!snapshot) throw new Error('The task browser page has no session');
    const registered = await rpc.browser.registerSession({ browserId: snapshot.browserId, partition: snapshot.partition, sessionId: snapshot.sessionId });
    check(); if (!registered.success) throw new Error(registered.error);
    const ready = await rpc.browser.ensureAgentPage({ browserId: snapshot.browserId, partition: snapshot.partition, url: snapshot.currentUrl });
    check(); if (!ready.success) throw new Error(`could not restore the browser page: ${ready.error}`);
    const created = !page.prepared; end(true);
    return { browserId: snapshot.browserId, created };
  } catch (error) { rollback(); throw error; }
  finally { clearTimeout(timer); signal.removeEventListener('abort', rollback); }
}
