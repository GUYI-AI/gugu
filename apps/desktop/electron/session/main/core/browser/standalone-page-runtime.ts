import { clipboard, ClipboardItem, dialog } from 'electron';
import { getMainWindow } from '@main/app/window';
import { events } from '@main/lib/events';
import { browserCloseTabChannel, browserOpenInNewTabChannel, browserPageEventChannel, browserTaskPagePacketChannel, browserTaskPageStateChannel } from '@shared/events/browserEvents';
import { BROWSER_PAGE_MEASURE_SCRIPT, parseBrowserPageLayout } from '@shared/browser-page-layout';
import type { AnnotationConversation } from '@shared/browser-annotation';
import type { BrowserKernelKind } from '@shared/browser-kernel';
import type { BrowserPageCommand } from './browser-page-views';
import type { TaskPageContents, TaskPageScreenTarget } from '../../../../server/server-task-browser';
import { BrowserKernelBindings } from './browser-kernel-bindings';
import { standaloneKernelService } from './standalone-kernel-service';
import { browserWebContentsRegistry } from './browser-webcontents-registry';
import { connectTaskPageScreen } from './task-page-screen';
import { watchTaskPageConnection } from './remote-task-page';
import { wireStandalonePageDialogs, type AskPerson, type DialogPage } from './standalone-page-dialogs';
import { wireStandalonePageFeatures, type FeatureHost, type FeaturePage } from './standalone-page-features';
import { kernelAfterCapabilityGate } from './standalone-capability-gate';
import { TaskPopupClosed } from '../../../../server/task-popups';
import { remoteBrowserBinding } from './remote-loopback-requests';
import { appSettingsService } from '../settings/settings-service';
import { log } from '@main/lib/logger';

export const browserKernelBindings = new BrowserKernelBindings();
const contents = new Map<string, TaskPageContents>();

/** The same message box the built-in browser puts over the Gugu window for a page's alert and confirm. */
const askPerson: AskPerson = ({ type, message, signal }) => {
  const window = getMainWindow();
  if (!window || window.isDestroyed()) return null;
  return dialog.showMessageBox(window, {
    message,
    signal,
    ...(type === 'confirm' ? { buttons: ['OK', 'Cancel'], defaultId: 0, cancelId: 1 } : { buttons: ['OK'], defaultId: -1, cancelId: 0 }),
  }).then(({ response }) => response === 0);
};

function dialogPage(page: TaskPageContents): DialogPage | null {
  const { answerJavaScriptDialog, isScreening, agentListening } = page;
  if (!answerJavaScriptDialog || !isScreening || !agentListening) return null;
  return {
    on: (event, listener) => page.on(event, listener),
    answerJavaScriptDialog: accept => answerJavaScriptDialog.call(page, accept),
    isScreening: () => isScreening.call(page),
    agentListening: () => agentListening.call(page),
  };
}

function featurePage(page: TaskPageContents): FeaturePage | null {
  const { reportNewWindows, keepWindow, closeWindow, announceFavicons, interceptFileChoosers, setFileInputFiles } = page;
  if (!reportNewWindows || !keepWindow || !closeWindow || !announceFavicons || !interceptFileChoosers || !setFileInputFiles) return null;
  return {
    on: (event, listener) => page.on(event, listener),
    reportNewWindows: () => reportNewWindows.call(page),
    keepWindow: popup => keepWindow.call(page, popup),
    closeWindow: popup => closeWindow.call(page, popup),
    get adoptedWindow() { return page.adoptedWindow === true; },
    announceFavicons: () => announceFavicons.call(page),
    interceptFileChoosers: () => interceptFileChoosers.call(page),
    setFileInputFiles: (backendNodeId, files) => setFileInputFiles.call(page, backendNodeId, files),
  };
}

/** The same open-file dialog the built-in browser puts over the Gugu window for an `<input type=file>`. */
async function chooseFiles({ multiple }: { multiple: boolean }): Promise<string[] | null> {
  const window = getMainWindow();
  if (!window || window.isDestroyed()) return null;
  const { canceled, filePaths } = await dialog.showOpenDialog(window, { properties: multiple ? ['openFile', 'multiSelections'] : ['openFile'] });
  return canceled ? null : filePaths;
}

export function registerBrowserKernel(input: { browserId: string; partition: string; sessionId?: string; conversation?: AnnotationConversation; kernel?: BrowserKernelKind; url?: string }) {
  return browserKernelBindings.run(input.browserId, async () => {
    const old = browserKernelBindings.get(input.browserId);
    browserKernelBindings.assertOwner(input);
    if (old && old.partition !== input.partition) await closeStandalonePage(input.browserId);
    // Internal preview/file protocols belong to Electron and never leave its document sandbox.
    const web = !input.url || input.url === 'about:blank' || /^https?:\/\//i.test(input.url);
    const wanted = web ? input.kernel ?? await standaloneKernelService().selection() : 'builtin';
    const kernel = old?.kernel ?? await kernelAfterCapabilityGate(wanted, input.browserId, {
      remoteSession: browserId => remoteBrowserBinding(browserId) !== null,
      relaxCorsForLocalhost: async () => (await appSettingsService.get('browser')).relaxCorsForLocalhost,
    });
    if (kernel === 'standalone' && !await standaloneKernelService().installation()) throw new Error('The standalone browser is not installed');
    if (kernel === 'standalone') standaloneKernelService().pool.reserveTab(input.browserId, input.partition);
    return browserKernelBindings.bind(input, kernel);
  });
}

export function unregisterBrowserKernel(browserId: string) {
  return browserKernelBindings.run(browserId, async () => {
    if (isStandalonePage(browserId)) await closeStandalonePage(browserId);
    browserKernelBindings.delete(browserId);
    browserWebContentsRegistry.unregisterSession(browserId);
  });
}

export function isStandalonePage(browserId: string): boolean { return browserKernelBindings.get(browserId)?.kernel === 'standalone'; }

export async function standalonePage(browserId: string, url?: string, signal: AbortSignal = AbortSignal.timeout(30_000), popup?: string) {
  const binding = browserKernelBindings.get(browserId);
  if (!binding || binding.kernel !== 'standalone' || !browserWebContentsRegistry.isRegistered(browserId, binding.partition)) {
    throw new Error('This standalone browser tab is not registered');
  }
  if (url && url !== 'about:blank' && !/^https?:\/\//i.test(url)) throw new Error('Only web pages open in the standalone browser');
  const page = await standaloneKernelService().pool.pageFor({ ...binding, url, popup, signal }).catch((error: unknown) => {
    // The tab was opened for a window that had already closed itself: the tab goes too.
    if (error instanceof TaskPopupClosed) events.emit(browserCloseTabChannel, { browserId });
    throw error;
  });
  if (contents.get(browserId) !== page) {
    contents.set(browserId, page);
    const dialogs = dialogPage(page);
    if (dialogs) wireStandalonePageDialogs(dialogs, askPerson);
    const screen = await standaloneKernelService().pool.existingPage(browserId);
    if (!screen) throw new Error('The standalone browser page closed');
    const features = featurePage(page);
    if (features) {
      const host: FeatureHost = {
        openInNewTab: (url, popup) => events.emit(browserOpenInNewTabChannel, { sourceBrowserId: browserId, url, ...(popup && { popup }) }),
        chooseFiles,
        closeTab: () => { if (contents.get(browserId) === page) events.emit(browserCloseTabChannel, { browserId }); },
        faviconsUpdated: favicons => events.emit(browserPageEventChannel, { browserId, type: 'page-favicon-updated', state: screen.state(), detail: { favicons } }),
        loadFailed: failure => events.emit(browserPageEventChannel, { browserId, type: 'did-fail-load', state: screen.state(), detail: { ...failure, isMainFrame: true } }),
        report: (message, error) => log.warn(message, { browserId, error: String(error) }),
      };
      await wireStandalonePageFeatures(features, host);
    }
    let loading = false;
    let address = '';
    const report = () => {
      const state = screen.state();
      const emit = (type: 'dom-ready' | 'did-navigate' | 'did-start-loading' | 'did-stop-loading' | 'page-title-updated') =>
        events.emit(browserPageEventChannel, { browserId, type, state, detail: { url: state.url, title: state.title } });
      if (address !== state.url) { address = state.url; emit('did-navigate'); }
      if (loading !== state.isLoading) { loading = state.isLoading; emit(loading ? 'did-start-loading' : 'did-stop-loading'); }
      if (!loading) emit('dom-ready');
      emit('page-title-updated');
    };
    screen.on('state', report);
    screen.once('destroyed', () => { screen.off('state', report); if (contents.get(browserId) === page) contents.delete(browserId); });
    report();
  }
  return page;
}

export async function standaloneScreen(browserId: string): Promise<TaskPageScreenTarget> {
  await standalonePage(browserId);
  const page = await standaloneKernelService().pool.existingPage(browserId);
  if (!page) throw new Error('The standalone browser page closed');
  return page;
}

export async function mountStandalonePage(input: { browserId: string; partition: string; url: string; popup?: string }) {
  if (!browserWebContentsRegistry.isRegistered(input.browserId, input.partition)) throw new Error('Browser profile mismatch');
  const reused = contents.has(input.browserId);
  await standalonePage(input.browserId, input.url, undefined, input.popup);
  const state = (await standaloneScreen(input.browserId)).state();
  return { success: true as const, reused, ready: !state.isLoading, state };
}

export async function standaloneCommand(browserId: string, command: BrowserPageCommand) {
  if (command === 'focus') return true; // Focus belongs to the renderer's projection input, never a Chrome window.
  if (command === 'reloadIgnoringCache') { await standaloneHostCommand(browserId, 'Page.reload', { ignoreCache: true }); return true; }
  const action = command === 'goBack' ? 'back' : command === 'goForward' ? 'forward' : command;
  await (await standaloneScreen(browserId)).control({ action });
  return true;
}

export async function setStandalonePageZoom(browserId: string, factor: number): Promise<void> {
  const page = await standalonePage(browserId);
  if (!page.setZoomFactor) throw new Error('The standalone browser layout zoom is unavailable');
  await page.setZoomFactor(factor);
}

export async function standaloneHostCommand(browserId: string, method: string, params: Record<string, unknown> = {}): Promise<unknown> {
  const page = await standalonePage(browserId);
  if (!page.hostCommand) throw new Error('The standalone browser host connection is unavailable');
  return page.hostCommand(method, params);
}

export async function snapshotStandalonePage(browserId: string): Promise<string> {
  const result = await standaloneHostCommand(browserId, 'Page.captureScreenshot', { format: 'png' }) as { data: string };
  if (!result.data) throw new Error('The standalone browser returned no screenshot');
  return `data:image/png;base64,${result.data}`;
}

export async function measureStandalonePage(browserId: string) {
  // A page measures the width it is laid out at, which is Chrome's own window width until the page has the size of its pane.
  await (await standalonePage(browserId)).sized?.();
  const result = await standaloneHostCommand(browserId, 'Runtime.evaluate', { expression: BROWSER_PAGE_MEASURE_SCRIPT, awaitPromise: true, returnByValue: true }) as { result?: { value?: unknown }; exceptionDetails?: unknown };
  if (result.exceptionDetails) throw new Error('Could not measure the standalone browser page');
  return parseBrowserPageLayout(result.result?.value);
}

export async function copyStandaloneScreenshot(browserId: string) {
  const dataUrl = await snapshotStandalonePage(browserId);
  await clipboard.write([new ClipboardItem({ 'image/png': new Blob([new Uint8Array(Buffer.from(dataUrl.split(',')[1]!, 'base64'))]) })]);
  return true;
}

export async function watchStandalonePage(input: { browserId: string; watchId: string }) {
  return watchTaskPageConnection(input.watchId, () => connectTaskPageScreen(`standalone:${input.browserId}`,
    async () => standaloneScreen(input.browserId),
    packet => events.emit(browserTaskPagePacketChannel, { watchId: input.watchId, packet }),
    state => events.emit(browserTaskPageStateChannel, { watchId: input.watchId, state }), true));
}

export async function closeStandalonePage(browserId: string) {
  contents.delete(browserId);
  await standaloneKernelService().pool.closeTab(browserId);
}
