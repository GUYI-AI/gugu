import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act } from 'react';
import { page } from 'vitest/browser';
import { createReactHarness } from '../../../../../../../tests/support/testHarness';
import { until } from '../../../../../../../tests/support/awaitCondition';
import { browserPageEventChannel, type BrowserPageEventType } from '@shared/events/browserEvents';
import { BrowserPageSurface } from '@renderer/features/browser/browser-page-surface';
import { StandaloneBrowserPane } from '@renderer/features/browser/browser-pane';
import { browserSessionStore } from '@renderer/features/browser/browser-session-store';
import '@/styles/tokens.css';
import '@renderer/index.css';

// The page in a browser tab is a native view drawn above the UI; whatever the UI lays over it (start page, load error)
// only stays visible while the placeholder reports `occluded`. These guard the two ways it used to slip out:
// the start page stepping aside for the tab's own about:blank load, and occlusion only being re-sampled on a timer.

const ipc = vi.hoisted(() => {
  const listeners = new Map<unknown, Set<(payload: unknown) => void>>();
  const browser: Record<string, ReturnType<typeof vi.fn>> = {};
  const proxy = new Proxy(browser, { get: (target, key: string) => (target[key] ??= vi.fn(async () => undefined)) });
  const rpc = new Proxy({}, { get: (_target, key) => (key === 'browser' ? proxy : new Proxy({}, { get: () => vi.fn(async () => undefined) })) });
  return { listeners, browser: proxy, rpc };
});
vi.mock('@renderer/lib/ipc', async (importOriginal) => ({
  ...await importOriginal<typeof import('@renderer/lib/ipc')>(),
  rpcOn: () => ipc.rpc,
  events: {
    on: (channel: unknown, listener: (payload: unknown) => void) => {
      const set = ipc.listeners.get(channel) ?? new Set();
      ipc.listeners.set(channel, set);
      set.add(listener);
      return () => set.delete(listener);
    },
    emit: () => {},
  },
  rpc: ipc.rpc,
}));

const blank = { url: 'about:blank', title: '', canGoBack: false, canGoForward: false };
const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6zUkAAAAASUVORK5CYII=';
let harness: ReturnType<typeof createReactHarness>;

beforeEach(async () => {
  await page.viewport(900, 700);
  ipc.listeners.clear();
  vi.clearAllMocks();
  ipc.browser.registerSession.mockResolvedValue({ success: true });
  ipc.browser.mountPage.mockResolvedValue({ success: true, reused: false, ready: false, state: blank });
  ipc.browser.layoutPage.mockResolvedValue(true);
  ipc.browser.snapshotPage.mockResolvedValue({ dataUrl: image });
  ipc.browser.releasePage.mockResolvedValue(true);
  harness = createReactHarness();
});
afterEach(() => harness.cleanup());

const modes = () => ipc.browser.layoutPage.mock.calls.map(([args]) => (args as { mode: string }).mode);
const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));

async function emitPage(browserId: string, type: BrowserPageEventType, detail: Record<string, unknown> = {}) {
  await act(async () => {
    for (const listener of ipc.listeners.get(browserPageEventChannel) ?? []) listener({ browserId, type, detail, state: blank });
  });
}

it('keeps the start page over a new tab while the tab loads its own blank page', async () => {
  const session = browserSessionStore.createSession({ projectId: 'chat', workspaceId: 'start-cover', sessionId: '', initialUrl: 'about:blank' });
  await harness.render(<div style={{ position: 'fixed', inset: 0 }}><StandaloneBrowserPane browserId={session.browserId} visible /></div>);
  await until('the page is mounted under the start page', () => ipc.browser.mountPage.mock.calls.length > 0 && modes().includes('occluded'));
  const placeholder = harness.container.querySelector<HTMLElement>('[data-browser-page]')!;
  const layer = placeholder.parentElement!;
  const covers = () => [...layer.children].filter((child) => child !== placeholder && child.classList.contains('absolute'));
  expect(covers()).toHaveLength(1);
  const removed: Node[] = [];
  const watch = new MutationObserver((records) => { for (const record of records) removed.push(...record.removedNodes); });
  watch.observe(layer, { childList: true });
  ipc.browser.layoutPage.mockClear();

  // What the main process reports for a new tab: its first navigation is to about:blank.
  await emitPage(session.browserId, 'did-start-loading');
  for (let i = 0; i < 3; i++) await nextFrame();
  await emitPage(session.browserId, 'did-navigate', { url: 'about:blank' });
  await emitPage(session.browserId, 'dom-ready');
  await emitPage(session.browserId, 'did-stop-loading');
  for (let i = 0; i < 3; i++) await nextFrame();

  watch.disconnect();
  expect(removed, 'the start page left the screen during the blank load').toEqual([]);
  expect(covers()).toHaveLength(1);
  expect(modes()).not.toContain('shown');
});

it('re-checks occlusion as soon as a cover in the page layer is removed, not on the next sample', async () => {
  // No frame loop and no fallback timer: only a DOM change may trigger a re-check.
  vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(0);
  let fallback: (() => void) | undefined;
  const original = window.setInterval.bind(window);
  vi.spyOn(window, 'setInterval').mockImplementation(((handler: TimerHandler, delay?: number, ...args: unknown[]) => {
    if (delay === 250 && typeof handler === 'function') {
      fallback = () => handler(...args);
      return 0;
    }
    return original(handler, delay, ...args);
  }) as typeof window.setInterval);
  ipc.browser.mountPage.mockResolvedValue({ success: true, reused: false, ready: true, state: blank });
  const layer = (covered: boolean) => <div style={{ position: 'fixed', inset: 0 }}>
    <style>{'[data-browser-page] { width: 100%; height: 100%; }'}</style>
    <BrowserPageSurface browserId="cover-recheck" partition="persist:test" initialUrl="about:blank" visible onHandle={() => {}} />
    {covered && <div className="absolute" style={{ position: 'absolute', inset: 0, background: '#fff' }}>start page</div>}
  </div>;
  await harness.render(layer(true));
  await until('the page is mounted', () => ipc.browser.mountPage.mock.calls.length > 0);
  await Promise.resolve();
  expect(fallback).toBeDefined();
  fallback!();
  await until('the covered page is reported occluded', () => modes().includes('occluded'));
  ipc.browser.layoutPage.mockClear();

  await harness.render(layer(false));
  await Promise.resolve();
  expect(modes()).toEqual(['shown']);
});

it('keeps a page its own start page covers occluded even on a frame where hit testing cannot see the cover', async () => {
  // A side panel sliding in: on its first frame the start page is not yet hit-testable (here: pointer-events none),
  // so sampling alone reads the page as uncovered and the native view would show over the start page.
  ipc.browser.mountPage.mockResolvedValue({ success: true, reused: false, ready: true, state: blank });
  await harness.render(<div style={{ position: 'fixed', inset: 0 }}>
    <style>{'[data-browser-page] { width: 100%; height: 100%; }'}</style>
    <BrowserPageSurface browserId="cover-prop" partition="persist:test" initialUrl="about:blank" visible covered onHandle={() => {}} />
    <div className="absolute" style={{ position: 'absolute', inset: 0, background: '#fff', pointerEvents: 'none' }}>start page</div>
  </div>);
  await until('the covered page is reported occluded', () => modes().includes('occluded'));
  expect(modes()).not.toContain('shown');
});
