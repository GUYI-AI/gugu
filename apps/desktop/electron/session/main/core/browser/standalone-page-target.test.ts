import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PageTarget, type PipeConnection } from '../../../../server/server-task-browser';

vi.mock('@gugu/core/local/state/agentFileBoundary', () => ({ requireAgentFileTreeAccess: async () => {} }));

const TARGET = 'T1';
const WATCH = 'S-watch';
const AGENT = 'S-agent';

/** A Chrome that answers the few commands a page needs to be watched, and records what it was asked. */
async function fixture(replies: Record<string, (params: Record<string, unknown>, sessionId?: string) => unknown> = {}) {
  const connection = Object.assign(new EventEmitter(), {
    sent: [] as { method: string; params: Record<string, unknown>; sessionId?: string }[],
    closed: null,
    send: vi.fn(async (method: string, params: Record<string, unknown> = {}, sessionId?: string) => {
      connection.sent.push({ method, params, sessionId });
      if (replies[method]) return replies[method]!(params, sessionId);
      if (method === 'Target.attachToTarget') return { sessionId: connection.sent.filter(call => call.method === method).length === 1 ? WATCH : AGENT };
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main', url: 'about:blank' } } };
      if (method === 'Page.getNavigationHistory') return { currentIndex: 0, entries: [{ id: 1, url: 'about:blank' }] };
      return {};
    }),
  });
  const target = new PageTarget(connection as unknown as PipeConnection, TARGET);
  await target.watch();
  const event = (method: string, params: Record<string, unknown>, sessionId?: string) => connection.emit('event', { method, params, ...(sessionId ? { sessionId } : {}) });
  const settle = () => new Promise(resolve => setTimeout(resolve, 5));
  const sentMethods = (method: string) => connection.sent.filter(call => call.method === method);
  return { connection, target, event, settle, sentMethods };
}

describe('a standalone page: windows it opens', () => {
  const windowOpen = (url: string, userGesture = true, windowFeatures?: string[]) => ({ url, windowName: '_blank', userGesture, ...(windowFeatures && { windowFeatures }) });
  const created = (targetId: string, extra: Record<string, unknown> = {}) => ({ targetInfo: { targetId, type: 'page', openerId: TARGET, url: '', ...extra } });

  it('reports the address of a window the page opens together with the Chrome page it opened, and leaves that page open to be adopted', async () => {
    const f = await fixture();
    f.target.reportNewWindows();
    const opened: unknown[] = [];
    f.target.on('window-open', (open: unknown) => opened.push(open));
    f.event('Page.windowOpen', windowOpen('http://site.test/next'), WATCH);
    f.event('Target.targetCreated', created('P1'));
    expect(opened).toEqual([{ url: 'http://site.test/next', popup: 'P1', opener: true }]);
    expect(f.sentMethods('Target.closeTarget')).toEqual([]);
  });

  it('pairs several windows in the order they were opened', async () => {
    const f = await fixture();
    f.target.reportNewWindows();
    const opened: unknown[] = [];
    f.target.on('window-open', (open: unknown) => opened.push(open));
    f.event('Page.windowOpen', windowOpen('http://a.test/'), WATCH);
    f.event('Page.windowOpen', windowOpen('http://b.test/'), WATCH);
    f.event('Target.targetCreated', created('P1'));
    f.event('Target.targetCreated', created('P2'));
    expect(opened).toEqual([{ url: 'http://a.test/', popup: 'P1', opener: true }, { url: 'http://b.test/', popup: 'P2', opener: true }]);
  });

  it('calls a window that opens empty about:blank, as the page may point it somewhere later', async () => {
    const f = await fixture();
    f.target.reportNewWindows();
    const opened: unknown[] = [];
    f.target.on('window-open', (open: unknown) => opened.push(open));
    f.event('Page.windowOpen', windowOpen(''), WATCH);
    f.event('Target.targetCreated', created('P1'));
    expect(opened).toEqual([{ url: 'about:blank', popup: 'P1', opener: true }]);
  });

  it('reports how the page asked for the window and whether the window can reach the page that opened it', async () => {
    const f = await fixture();
    f.target.reportNewWindows();
    const opened: unknown[] = [];
    f.target.on('window-open', (open: unknown) => opened.push(open));
    f.event('Page.windowOpen', windowOpen('http://a.test/', true, ['width=480', 'height=640', 'resizable']), WATCH);
    f.event('Target.targetCreated', created('P1', { canAccessOpener: true }));
    f.event('Page.windowOpen', windowOpen('http://b.test/', true, ['menubar', 'toolbar', 'status', 'scrollbars', 'resizable', 'noopener']), WATCH);
    f.event('Target.targetCreated', created('P2', { canAccessOpener: false }));
    expect(opened).toEqual([
      { url: 'http://a.test/', popup: 'P1', features: ['width=480', 'height=640', 'resizable'], opener: true },
      { url: 'http://b.test/', popup: 'P2', features: ['menubar', 'toolbar', 'status', 'scrollbars', 'resizable', 'noopener'], opener: false },
    ]);
  });

  it('reports a blocked window with how the page asked for it as well', async () => {
    const f = await fixture();
    f.target.reportNewWindows();
    const opened: unknown[] = [];
    f.target.on('window-open', (open: unknown) => opened.push(open));
    f.event('Page.windowOpen', windowOpen('http://ads.test/', false, ['resizable']), WATCH);
    expect(opened).toEqual([{ url: 'http://ads.test/', features: ['resizable'] }]);
  });

  it('closes a window Chrome created when Gugu has no tab to show it in, at once rather than after the wait', async () => {
    const f = await fixture();
    f.target.closeWindow('P1');
    expect(f.sentMethods('Target.closeTarget').map(call => call.params)).toEqual([{ targetId: 'P1' }]);
  });

  it('does not mind that a window it was told to close is already gone', async () => {
    const f = await fixture({ 'Target.closeTarget': () => { throw new Error('No target with given id found'); } });
    expect(() => f.target.closeWindow('P1')).not.toThrow();
    await f.settle();
  });

  it('reports at once, by address only, a window Chrome blocked because no one clicked: no page exists to adopt', async () => {
    const f = await fixture();
    f.target.reportNewWindows();
    const opened: unknown[] = [];
    f.target.on('window-open', (open: unknown) => opened.push(open));
    f.event('Page.windowOpen', windowOpen('http://ads.test/', false), WATCH);
    expect(opened).toEqual([{ url: 'http://ads.test/' }]);
  });

  it('reports by address only when Chrome never creates the page it was told about', async () => {
    vi.useFakeTimers();
    try {
      const f = await fixture();
      f.target.reportNewWindows();
      const opened: unknown[] = [];
      f.target.on('window-open', (open: unknown) => opened.push(open));
      f.event('Page.windowOpen', windowOpen('http://site.test/lost'), WATCH);
      expect(opened).toEqual([]);
      await vi.advanceTimersByTimeAsync(1500);
      expect(opened).toEqual([{ url: 'http://site.test/lost' }]);
      f.event('Target.targetCreated', created('P-late')); // Nothing left to pair it with.
      expect(opened).toHaveLength(2);
    } finally { vi.useRealTimers(); }
  });

  it('leaves windows alone that another page opened, that are not pages, or when nothing asked to hear about them', async () => {
    const f = await fixture();
    const opened: unknown[] = [];
    f.target.on('window-open', (open: unknown) => opened.push(open));
    f.event('Page.windowOpen', windowOpen('http://site.test/x'), WATCH);
    f.event('Target.targetCreated', created('P0'));
    f.target.reportNewWindows();
    f.event('Target.targetCreated', created('P2', { openerId: 'another-page' }));
    f.event('Target.targetCreated', created('W1', { type: 'service_worker' }));
    f.event('Target.targetCreated', { targetInfo: { targetId: 'P3', type: 'page' } });
    expect(opened).toEqual([]);
    expect(f.sentMethods('Target.closeTarget')).toEqual([]);
  });
});

describe('a standalone page: Chrome closes it', () => {
  it('tells when the page closes itself, as window.close() does, but not when Gugu closed it', async () => {
    const f = await fixture();
    const closed: unknown[] = [];
    f.target.on('closed-by-page', () => closed.push('closed'));
    f.target.expectClose();
    f.event('Target.targetDestroyed', { targetId: TARGET });
    expect(closed).toEqual([]);
    expect(f.target.isDestroyed()).toBe(true);
    const g = await fixture();
    const gClosed: unknown[] = [];
    g.target.on('closed-by-page', () => gClosed.push('closed'));
    g.event('Target.targetDestroyed', { targetId: 'another-page' });
    expect(gClosed).toEqual([]);
    g.event('Target.targetDestroyed', { targetId: TARGET });
    expect(gClosed).toEqual(['closed']);
    expect(g.target.isDestroyed()).toBe(true);
  });
});

describe('a standalone page: the icon in the tab', () => {
  const icons = (value: unknown) => ({ 'Runtime.evaluate': () => ({ result: { value } }) });

  it('reports the icons the loaded page declares, once for a document', async () => {
    const f = await fixture(icons(['http://site.test/fav.png', 'http://site.test/touch.png']));
    const updated: unknown[] = [];
    f.target.on('page-favicon-updated', (detail: unknown) => updated.push(detail));
    f.event('Page.frameStoppedLoading', { frameId: 'main' }, WATCH);
    await f.settle();
    f.event('Page.navigatedWithinDocument', { frameId: 'main', url: 'http://site.test/#x' }, WATCH);
    await f.settle();
    expect(updated).toEqual([{ favicons: ['http://site.test/fav.png', 'http://site.test/touch.png'] }]);
  });

  it('reports again for the next document and when the list changes within one', async () => {
    let value: string[] = ['http://site.test/a.png'];
    const f = await fixture({ 'Runtime.evaluate': () => ({ result: { value } }) });
    const updated: unknown[] = [];
    f.target.on('page-favicon-updated', (detail: unknown) => updated.push(detail));
    f.event('Page.frameStoppedLoading', { frameId: 'main' }, WATCH); await f.settle();
    value = ['http://site.test/b.png'];
    f.event('Page.navigatedWithinDocument', { frameId: 'main', url: 'http://site.test/#y' }, WATCH); await f.settle();
    f.event('Page.frameNavigated', { frame: { id: 'main', url: 'http://other.test/' } }, WATCH);
    value = ['http://site.test/b.png'];
    f.event('Page.frameStoppedLoading', { frameId: 'main' }, WATCH); await f.settle();
    expect(updated).toEqual([{ favicons: ['http://site.test/a.png'] }, { favicons: ['http://site.test/b.png'] }, { favicons: ['http://site.test/b.png'] }]);
  });

  it('announces the icons on request even when it already reported them, for a tab that started listening after the page loaded', async () => {
    const f = await fixture(icons(['http://site.test/fav.png']));
    f.event('Page.frameStoppedLoading', { frameId: 'main' }, WATCH);
    await f.settle();
    const updated: unknown[] = [];
    f.target.on('page-favicon-updated', (detail: unknown) => updated.push(detail));
    await f.target.announceFavicons();
    expect(updated).toEqual([{ favicons: ['http://site.test/fav.png'] }]);
  });

  it('says nothing for a page without icons or one that cannot be read', async () => {
    for (const replies of [icons([]), icons(undefined), { 'Runtime.evaluate': () => { throw new Error('gone'); } }]) {
      const f = await fixture(replies);
      const updated: unknown[] = [];
      f.target.on('page-favicon-updated', (detail: unknown) => updated.push(detail));
      f.event('Page.frameStoppedLoading', { frameId: 'main' }, WATCH);
      await f.settle();
      expect(updated).toEqual([]);
    }
  });
});

describe('a standalone page: file choosers', () => {
  it('has Chrome hand over the file chooser, reports it, and fills the input with the files the person picked', async () => {
    const f = await fixture();
    await f.target.interceptFileChoosers();
    expect(f.sentMethods('Page.setInterceptFileChooserDialog')).toEqual([{ method: 'Page.setInterceptFileChooserDialog', params: { enabled: true }, sessionId: WATCH }]);
    const opened: unknown[] = [];
    f.target.on('file-chooser', (chooser: unknown) => opened.push(chooser));
    f.event('Page.fileChooserOpened', { frameId: 'main', mode: 'selectMultiple', backendNodeId: 7 }, WATCH);
    f.event('Page.fileChooserOpened', { frameId: 'main', mode: 'selectSingle', backendNodeId: 8 }, WATCH);
    expect(opened).toEqual([{ multiple: true, backendNodeId: 7 }, { multiple: false, backendNodeId: 8 }]);
    await f.target.setFileInputFiles(7, ['/tmp/a.txt', '/tmp/b.txt']);
    expect(f.sentMethods('DOM.setFileInputFiles')).toEqual([{ method: 'DOM.setFileInputFiles', params: { files: ['/tmp/a.txt', '/tmp/b.txt'], backendNodeId: 7 }, sessionId: WATCH }]);
  });

  it('leaves the chooser to an agent that has asked for it, as the built-in browser does', async () => {
    const f = await fixture();
    await f.target.interceptFileChoosers();
    f.target.debugger.attach();
    await f.target.debugger.sendCommand('Page.setInterceptFileChooserDialog', { enabled: true });
    const opened: unknown[] = [];
    f.target.on('file-chooser', (chooser: unknown) => opened.push(chooser));
    f.event('Page.fileChooserOpened', { mode: 'selectSingle', backendNodeId: 1 }, WATCH);
    expect(opened).toEqual([]);
    f.target.debugger.detach();
    f.event('Page.fileChooserOpened', { mode: 'selectSingle', backendNodeId: 2 }, WATCH);
    expect(opened).toEqual([{ multiple: false, backendNodeId: 2 }]);
  });
});

describe('a standalone page: a main frame that fails to load', () => {
  const failure = (url: string, extra: Record<string, unknown> = {}) => ({ frame: { id: 'main', url: 'chrome-error://chromewebdata/', unreachableUrl: url, ...extra } });

  it('reports Electron\'s did-fail-load with the error Chrome names on its error page', async () => {
    const f = await fixture({ 'Runtime.evaluate': () => ({ result: { value: 'net::ERR_CERT_AUTHORITY_INVALID' } }) });
    const failed: unknown[] = [];
    f.target.on('did-fail-load', (detail: unknown) => failed.push(detail));
    f.event('Page.frameNavigated', failure('https://bad.test/'), WATCH);
    await f.settle();
    expect(failed).toEqual([{ errorCode: -202, errorDescription: 'ERR_CERT_AUTHORITY_INVALID', validatedURL: 'https://bad.test/' }]);
    expect(f.target.state().url).toBe('https://bad.test/'); // The address bar keeps what the person asked for, not Chrome's error page.
  });

  it('still reports the failure when the error page cannot be read', async () => {
    const f = await fixture({ 'Runtime.evaluate': () => { throw new Error('gone'); } });
    const failed: unknown[] = [];
    f.target.on('did-fail-load', (detail: unknown) => failed.push(detail));
    f.event('Page.frameNavigated', failure('http://down.test/'), WATCH);
    await f.settle();
    expect(failed).toEqual([{ errorCode: -2, errorDescription: 'ERR_FAILED', validatedURL: 'http://down.test/' }]);
  });

  it('ignores pages that loaded and frames inside the page', async () => {
    const f = await fixture();
    const failed: unknown[] = [];
    f.target.on('did-fail-load', (detail: unknown) => failed.push(detail));
    f.event('Page.frameNavigated', { frame: { id: 'main', url: 'http://ok.test/' } }, WATCH);
    f.event('Page.frameNavigated', { frame: { id: 'child', parentId: 'main', url: 'chrome-error://chromewebdata/', unreachableUrl: 'http://ads.test/' } }, WATCH);
    await f.settle();
    expect(failed).toEqual([]);
  });
});

describe('a standalone page: Chrome reloads its own error page', () => {
  const failure = (url: string) => ({ frame: { id: 'main', url: 'chrome-error://chromewebdata/', unreachableUrl: url } });
  const MAIN = 'main';
  /** What Chrome does about a second after it showed an error page: it reloads the page itself, and says nothing more about the failure. */
  const chromeReloads = (f: Awaited<ReturnType<typeof fixture>>) => {
    f.event('Page.frameStartedNavigating', { frameId: MAIN, url: 'http://down.test/', navigationType: 'reload' }, WATCH);
    f.event('Page.frameStartedLoading', { frameId: MAIN }, WATCH);
  };
  const watchLoading = (f: Awaited<ReturnType<typeof fixture>>) => {
    const loading: boolean[] = [];
    f.target.on('state', () => loading.push(f.target.state().isLoading));
    const stopped: number[] = [];
    f.target.on('did-stop-loading', () => stopped.push(stopped.length));
    return { loading, stopped };
  };
  const mainFrame = (f: Awaited<ReturnType<typeof fixture>>) => f.event('Page.frameNavigated', { frame: { id: MAIN, url: 'http://start.test/' } }, WATCH);

  it.each([
    ['a refused connection', 'ERR_CONNECTION_REFUSED', -102],
    ['a port Chrome will not use', 'ERR_UNSAFE_PORT', -9],
  ])('does not take Chrome\'s reload of the error page for %s as a new load, so the failure stays shown', async (_name, line, code) => {
    const f = await fixture({ 'Runtime.evaluate': () => ({ result: { value: line } }) });
    const failed: unknown[] = [];
    f.target.on('did-fail-load', (detail: unknown) => failed.push(detail));
    mainFrame(f);
    f.event('Page.frameNavigated', failure('http://down.test/'), WATCH);
    await f.settle();
    const seen = watchLoading(f);
    chromeReloads(f);
    expect(f.target.state().isLoading).toBe(false);
    f.event('Page.frameStoppedLoading', { frameId: MAIN }, WATCH);
    await f.settle();
    expect(seen.loading).not.toContain(true);
    expect(seen.stopped).toEqual([]);
    expect(f.target.state().url).toBe('http://down.test/');
    expect(failed).toEqual([{ errorCode: code, errorDescription: line, validatedURL: 'http://down.test/' }]);
  });

  it('still takes a reload Gugu asked for on the error page as a load', async () => {
    const f = await fixture({ 'Runtime.evaluate': () => ({ result: { value: 'ERR_CONNECTION_REFUSED' } }) });
    f.event('Page.frameNavigated', failure('http://down.test/'), WATCH);
    await f.settle();
    await f.target.control({ action: 'reload' });
    chromeReloads(f);
    expect(f.target.state().isLoading).toBe(true);
    f.event('Page.frameStoppedLoading', { frameId: MAIN }, WATCH);
    expect(f.target.state().isLoading).toBe(false);
  });

  it('takes a reload the agent asked for through its own session as a load too', async () => {
    const f = await fixture({ 'Runtime.evaluate': () => ({ result: { value: 'ERR_CONNECTION_REFUSED' } }) });
    f.target.debugger.attach();
    f.event('Page.frameNavigated', failure('http://down.test/'), WATCH);
    await f.settle();
    await f.target.debugger.sendCommand('Page.reload', {});
    chromeReloads(f);
    expect(f.target.state().isLoading).toBe(true);
  });

  it('takes a reload of a page that did not fail as a load', async () => {
    const f = await fixture();
    mainFrame(f);
    f.event('Page.frameStartedNavigating', { frameId: MAIN, url: 'http://start.test/', navigationType: 'reload' }, WATCH);
    f.event('Page.frameStartedLoading', { frameId: MAIN }, WATCH);
    expect(f.target.state().isLoading).toBe(true);
  });

  it('takes the next address as a load, and a reload Chrome makes that ends on a working page as the page loaded', async () => {
    const f = await fixture({ 'Runtime.evaluate': () => ({ result: { value: 'ERR_CONNECTION_REFUSED' } }) });
    f.event('Page.frameNavigated', failure('http://down.test/'), WATCH);
    await f.settle();
    chromeReloads(f);
    f.event('Page.frameNavigated', { frame: { id: MAIN, url: 'http://down.test/' } }, WATCH); // The server came back.
    const seen = watchLoading(f);
    f.event('Page.frameStoppedLoading', { frameId: MAIN }, WATCH);
    expect(seen.stopped).toEqual([0]);
    f.event('Page.frameStartedNavigating', { frameId: MAIN, url: 'http://other.test/', navigationType: 'differentDocument' }, WATCH);
    f.event('Page.frameStartedLoading', { frameId: MAIN }, WATCH);
    expect(f.target.state().isLoading).toBe(true);
  });
});

describe('a standalone page: it has the size of its pane', () => {
  it('is sized once Gugu has resized it, and not before', async () => {
    const f = await fixture();
    let sized = false;
    void f.target.sized().then(() => { sized = true; });
    await f.settle();
    expect(sized).toBe(false);
    await f.target.control({ action: 'resize', width: 370, height: 700, scale: 1 });
    await f.settle();
    expect(sized).toBe(true);
    expect(f.sentMethods('Emulation.setDeviceMetricsOverride')[0]?.params).toMatchObject({ width: 370, height: 700 });
  });

  it('gives up waiting when the page closes before it was sized', async () => {
    const f = await fixture();
    const waiting = f.target.sized();
    f.target.destroy();
    await expect(waiting).rejects.toThrow('closed');
    await expect(f.target.sized()).rejects.toThrow('closed');
  });
});
