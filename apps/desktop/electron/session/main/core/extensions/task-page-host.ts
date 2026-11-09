import { ExtensionTaskPages } from './extension-task-pages';
import { extensionsService } from './extensions-root';
import { browserWebContentsRegistry } from '../browser/browser-webcontents-registry';
import { acquireBrowserPage } from '../browser/browser-page-runtime';
import { leasePageProtocol } from '../browser/leased-page-protocol';
import { sessionEvents } from '../sessions/session-events';
import { projectEvents } from '../projects/project-events';
import path from 'node:path';
import { app, BrowserWindow, type WebContents } from 'electron';
import type { ServerTaskBrowser } from '../../../../server/server-task-browser';
import { leaseBrowserPagePresentation, browserPagePresentation, onBrowserPagePresentation } from '../browser/browser-page-views';
import { extensionPagePresentation } from './extension-bridge';
import { log } from '@main/lib/logger';
import type { TaskPageNative, TaskPageRect } from './extension-task-pages';
import { taskPageViewport } from '@shared/extensions/task-page-viewport';
import { readTaskFilePayloads, taskFilePayloadSource } from './task-file-payloads';

/** The host chooses one task page. Apps never supply contents IDs or partitions. */
export const extensionTaskPages = new ExtensionTaskPages(extensionId => {
  const service = extensionsService();
  service.get(extensionId);
  if (!service.isEnabled(extensionId) || !service.hasCapability(extensionId, 'agents:tools')) {
    throw new Error('App task page access was revoked');
  }
}, async ({ sessionId, url, signal }) => {
  if (process.env.GUGU_SERVER_MODE === '1') return serverTaskPage(sessionId, url, signal);
  const { agentSessionContext } = await import('./extension-agent-context');
  const { openTaskBrowserPane } = await import('../sessions/session-orchestration');
  const { projectionTaskProject } = await import('./projection-task');
  const projectId = await projectionTaskProject(sessionId);
  signal.throwIfAborted();
  const context = await agentSessionContext(sessionId);
  signal.throwIfAborted();
  if (!context || context.projectId !== projectId) throw new Error('The task has no page on this computer');
  const browserId = await openTaskBrowserPane({ projectId, sessionId }, url ?? 'about:blank', signal);
  signal.throwIfAborted();
  const selected = browserWebContentsRegistry.browsersOfSession(sessionId).find(page => page.browserId === browserId);
  if (!selected || selected.webContents.isDestroyed()) throw new Error('The task page was closed before it could be leased');
  const page = acquireBrowserPage(selected.webContents);
  if (!page) throw new Error('The task page has no native page runtime');
  try {
    const { protocol, cleanup } = leasePageProtocol(selected.webContents, {
      ready: page.ready, capture: params => page.capture(params),
    });
    // Protocol observes this ready promise too; observe it before the first send.
    void page.ready.catch(() => {});
    return { projectId, title: selected.webContents.getTitle(), url: selected.webContents.getURL(), protocol,
      cleanup,
      presentation: () => browserPagePresentation(browserId),
      onPresentation: listener => onBrowserPagePresentation(browserId, listener),
      mount(caller, firstRect) {
        const presentation = extensionPagePresentation(caller);
        const host = BrowserWindow.fromWebContents(presentation.embedder);
        if (!host || host.isDestroyed()) throw new Error('The task App has no native host window');
        const mount = leaseBrowserPagePresentation(browserId, host);
        const layout = (rect: TaskPageRect) => {
          const current = extensionPagePresentation(caller);
          if (current.embedder !== presentation.embedder) throw new Error('The App host window changed');
          mount.layout(taskPageViewport(current.metrics, rect, current.scale));
        };
        try { layout(firstRect); } catch (error) { mount.close(); throw error; }
        return { layout, close: () => mount.close() };
      },
      setActive: (active: boolean) => page.setActive(active), release: () => page.dispose() };
  } catch (error) { page.dispose(); throw error; }
}, error => log.warn('Task page cleanup failed', { error: String(error) }),
async (caller, refs, signal) => readTaskFilePayloads(caller, refs, signal, await taskFilePayloadSource()));

sessionEvents.on('session:archived', sessionId => {
  extensionTaskPages.closeScope({ sessionId });
  if (serverBrowser) void serverBrowser.closeTask(sessionId);
});
projectEvents.on('project:deleted', projectId => extensionTaskPages.closeScope({ projectId }));

let serverBrowser: ServerTaskBrowser | null = null;

/**
 * #1607 4b: on a Gugu server the task's page is a page of the account's headless Chromium (server-task-browser.ts),
 * leased through the same restricted page protocol as a desktop tab. It has no window: people watch it through the
 * App, not a native view.
 */
async function serverTaskPage(sessionId: string, url: string | undefined, signal: AbortSignal): Promise<TaskPageNative> {
  const { agentSessionContext } = await import('./extension-agent-context');
  const context = await agentSessionContext(sessionId);
  signal.throwIfAborted();
  if (!context) throw new Error('The task has no page on this computer');
  if (!serverBrowser) {
    const { createServerTaskBrowser } = await import('../../../../server/server-task-browser');
    const { findAppBrowser } = await import('../../../../server/app-browser');
    serverBrowser = createServerTaskBrowser({ binary: () => findAppBrowser(process.env), log,
      profile: path.join(app.getPath('userData'), 'TaskBrowser') });
  }
  const contents = await serverBrowser.pageFor(sessionId, url, signal) as unknown as WebContents;
  signal.throwIfAborted();
  const { protocol, cleanup } = leasePageProtocol(contents, {
    ready: Promise.resolve(),
    capture: params => contents.debugger.sendCommand('Page.captureScreenshot', params),
  });
  return { projectId: context.projectId, title: contents.getTitle(), url: contents.getURL(), protocol, cleanup,
    presentation: () => null,
    onPresentation: () => () => {},
    setActive: () => {},
    // The page is the task's: releasing a lease hands it back, it does not close it.
    release: () => {} };
}
