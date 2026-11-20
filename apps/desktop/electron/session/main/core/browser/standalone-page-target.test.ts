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
  it('reports the address of a window the page opens and closes that window in Chrome when asked to', async () => {
    const f = await fixture();
    f.target.denyNewWindows();
    const opened: unknown[] = [];
    f.target.on('window-open', (open: unknown) => opened.push(open));
    f.event('Page.windowOpen', { url: 'http://site.test/next', windowName: '_blank', userGesture: true }, WATCH);
    f.event('Target.targetCreated', { targetInfo: { targetId: 'P1', type: 'page', openerId: TARGET, url: '' } });
    expect(opened).toEqual([{ url: 'http://site.test/next' }]);
    expect(f.sentMethods('Target.closeTarget').map(call => call.params)).toEqual([{ targetId: 'P1' }]);
  });

  it('leaves windows alone that another page opened, that are not pages, or when nothing asked for them to be closed', async () => {
    const f = await fixture();
    f.event('Target.targetCreated', { targetInfo: { targetId: 'P0', type: 'page', openerId: TARGET } });
    f.target.denyNewWindows();
    f.event('Target.targetCreated', { targetInfo: { targetId: 'P2', type: 'page', openerId: 'another-page' } });
    f.event('Target.targetCreated', { targetInfo: { targetId: 'W1', type: 'service_worker', openerId: TARGET } });
    f.event('Target.targetCreated', { targetInfo: { targetId: 'P3', type: 'page' } });
    expect(f.sentMethods('Target.closeTarget')).toEqual([]);
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
