import { clipboard, ClipboardItem } from 'electron';
import { events } from '@main/lib/events';
import { browserPageEventChannel, browserTaskPagePacketChannel, browserTaskPageStateChannel } from '@shared/events/browserEvents';
import { BROWSER_PAGE_MEASURE_SCRIPT, parseBrowserPageLayout } from '@shared/browser-page-layout';
import type { BrowserKernelKind } from '@shared/browser-kernel';
import type { BrowserPageCommand } from './browser-page-views';
import type { TaskPageContents, TaskPageScreenTarget } from '../../../../server/server-task-browser';
import { BrowserKernelBindings } from './browser-kernel-bindings';
import { standaloneKernelService } from './standalone-kernel-service';
import { browserWebContentsRegistry } from './browser-webcontents-registry';
import { connectTaskPageScreen } from './task-page-screen';
import { watchTaskPageConnection } from './remote-task-page';

export const browserKernelBindings = new BrowserKernelBindings();
const contents = new Map<string, TaskPageContents>();

export function registerBrowserKernel(input: { browserId: string; partition: string; sessionId?: string; kernel?: BrowserKernelKind; url?: string }) {
  return browserKernelBindings.run(input.browserId, async () => {
    const old = browserKernelBindings.get(input.browserId);
    if (old && old.sessionId !== input.sessionId) throw new Error('This browser tab belongs to another conversation');
    if (old && old.partition !== input.partition) await closeStandalonePage(input.browserId);
    // Internal preview/file protocols belong to Electron and never leave its document sandbox.
    const web = !input.url || input.url === 'about:blank' || /^https?:\/\//i.test(input.url);
    const kernel = old?.kernel ?? (web ? input.kernel ?? await standaloneKernelService().selection() : 'builtin');
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

export async function standalonePage(browserId: string, url?: string, signal: AbortSignal = AbortSignal.timeout(30_000)) {
  const binding = browserKernelBindings.get(browserId);
  if (!binding || binding.kernel !== 'standalone' || !browserWebContentsRegistry.isRegistered(browserId, binding.partition)) {
    throw new Error('This standalone browser tab is not registered');
  }
  if (url && url !== 'about:blank' && !/^https?:\/\//i.test(url)) throw new Error('Only web pages open in the standalone browser');
  const page = await standaloneKernelService().pool.pageFor({ ...binding, url, signal });
  if (contents.get(browserId) !== page) {
    contents.set(browserId, page);
    const screen = await standaloneKernelService().pool.existingPage(browserId);
    if (!screen) throw new Error('The standalone browser page closed');
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

export async function mountStandalonePage(input: { browserId: string; partition: string; url: string }) {
  if (!browserWebContentsRegistry.isRegistered(input.browserId, input.partition)) throw new Error('Browser profile mismatch');
  const reused = contents.has(input.browserId);
  await standalonePage(input.browserId, input.url);
  const state = (await standaloneScreen(input.browserId)).state();
  return { success: true as const, reused, ready: !state.isLoading, state };
}

export async function standaloneCommand(browserId: string, command: BrowserPageCommand) {
  if (command === 'focus') return true; // Focus belongs to the renderer's projection input, never a Chrome window.
  const action = command === 'goBack' ? 'back' : command === 'goForward' ? 'forward' : command === 'reloadIgnoringCache' ? 'reload' : command;
  await (await standaloneScreen(browserId)).control({ action });
  return true;
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
