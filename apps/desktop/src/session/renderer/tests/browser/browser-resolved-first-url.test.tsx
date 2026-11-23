import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { createReactHarness } from '../../../../../../../tests/support/testHarness';
import { until } from '../../../../../../../tests/support/awaitCondition';
import { StandaloneBrowserPane } from '@renderer/features/browser/browser-pane';
import { BrowserUrlResolverContext, type BrowserUrlResolution } from '@renderer/features/browser/browser-url-resolver';
import { browserSessionStore } from '@renderer/features/browser/browser-session-store';

// A tab on another machine opens with a remote `localhost:<port>` address. The page mounts blank and the first address
// goes through the resolver (which starts the SSH forward) before it is loaded. A forward that comes up only after the
// page is mounted must still load: the first "Open in browser" from the Ports tab used to stay on about:blank.

const ipc = vi.hoisted(() => {
  const browser: Record<string, ReturnType<typeof vi.fn>> = {};
  const proxy = new Proxy(browser, { get: (target, key: string) => (target[key] ??= vi.fn(async () => undefined)) });
  const rpc = new Proxy({}, { get: (_target, key) => (key === 'browser' ? proxy : new Proxy({}, { get: () => vi.fn(async () => undefined) })) });
  return { browser: proxy, rpc };
});
vi.mock('@renderer/lib/ipc', async (importOriginal) => ({
  ...await importOriginal<typeof import('@renderer/lib/ipc')>(),
  rpcOn: () => ipc.rpc,
  events: { on: () => () => {}, emit: () => {} },
  rpc: ipc.rpc,
}));

const blank = { url: 'about:blank', title: '', canGoBack: false, canGoForward: false };
let harness: ReturnType<typeof createReactHarness>;

beforeEach(() => {
  vi.clearAllMocks();
  ipc.browser.registerSession.mockResolvedValue({ success: true });
  ipc.browser.mountPage.mockResolvedValue({ success: true, reused: false, ready: false, state: blank });
  ipc.browser.layoutPage.mockResolvedValue(true);
  ipc.browser.releasePage.mockResolvedValue(true);
  harness = createReactHarness();
});
afterEach(() => harness.cleanup());

const navigations = () => ipc.browser.navigatePage.mock.calls.map(([args]) => (args as { url: string }).url);

async function openRemoteTab(workspaceId: string) {
  let finish!: (resolution: BrowserUrlResolution) => void;
  const resolve = vi.fn(() => new Promise<BrowserUrlResolution>((done) => { finish = done; }));
  const session = browserSessionStore.createSession({ projectId: 'chat', workspaceId, sessionId: '', initialUrl: 'http://localhost:8765/' });
  await harness.render(
    <div style={{ position: 'fixed', inset: 0 }}>
      <BrowserUrlResolverContext.Provider value={resolve}>
        <StandaloneBrowserPane browserId={session.browserId} visible />
      </BrowserUrlResolverContext.Provider>
    </div>
  );
  await until('the first address is sent to the resolver', () => resolve.mock.calls.length === 1);
  return { finish, resolve };
}

it('loads the resolved first address when the forward comes up after the page is mounted', async () => {
  const { finish, resolve } = await openRemoteTab('first-url-late');
  expect(resolve.mock.calls[0]![0]).toBe('http://localhost:8765/');
  await until('the blank page is mounted', () => ipc.browser.mountPage.mock.calls.length > 0);
  await new Promise((done) => setTimeout(done, 50));
  expect(navigations()).toEqual([]);

  finish({ url: 'http://127.0.0.1:18765/' });
  await until('the forwarded address is loaded', () => navigations().includes('http://127.0.0.1:18765/'));
  expect(navigations()).toEqual(['http://127.0.0.1:18765/']);
});

it('loads the resolved first address when the forward is up before the page is mounted', async () => {
  let mounted!: (result: unknown) => void;
  ipc.browser.mountPage.mockImplementation(() => new Promise((done) => { mounted = done; }));
  const { finish } = await openRemoteTab('first-url-early');
  finish({ url: 'http://127.0.0.1:18766/' });
  await new Promise((done) => setTimeout(done, 50));
  expect(navigations(), 'nothing to load into before the page exists').toEqual([]);

  await until('the page mount was requested', () => mounted !== undefined);
  mounted({ success: true, reused: false, ready: false, state: blank });
  await until('the forwarded address is loaded once the page exists', () => navigations().includes('http://127.0.0.1:18766/'));
  expect(navigations()).toEqual(['http://127.0.0.1:18766/']);
});
