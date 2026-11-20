import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PageTarget, type PipeConnection } from '../../../../server/server-task-browser';
import { windowPauser, WINDOW_DECISION_MS } from '../../../../server/task-window-pause';

vi.mock('@gugu/core/local/state/agentFileBoundary', () => ({ requireAgentFileTreeAccess: async () => {} }));

const OPENER = 'T1';
const WATCH = 'S-watch';

/** A Chrome that holds the windows pages open, as `Target.setAutoAttach` with `waitForDebuggerOnStart` makes it, and records every command. */
async function fixture(options: { failOn?: string; failWith?: string } = {}) {
  const connection = Object.assign(new EventEmitter(), {
    sent: [] as { method: string; params: Record<string, unknown>; sessionId?: string }[],
    closed: null,
    send: vi.fn(async (method: string, params: Record<string, unknown> = {}, sessionId?: string) => {
      connection.sent.push({ method, params, sessionId });
      if (method === options.failOn) throw new Error(options.failWith ?? `${method} refused`);
      if (method === 'Target.attachToTarget') return { sessionId: WATCH };
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main', url: 'about:blank' } } };
      if (method === 'Page.getNavigationHistory') return { currentIndex: 0, entries: [{ id: 1, url: 'about:blank' }] };
      return {};
    }),
  });
  const log = { warn: vi.fn(), info: vi.fn() };
  windowPauser(connection as unknown as PipeConnection, log);
  const target = new PageTarget(connection as unknown as PipeConnection, OPENER);
  await target.watch();
  target.reportNewWindows();
  const opened: unknown[] = [];
  target.on('window-open', (open: unknown) => opened.push(open));
  const methods = () => connection.sent.map(call => call.method);
  const calls = (method: string) => connection.sent.filter(call => call.method === method);
  const settle = () => new Promise(resolve => setTimeout(resolve, 5));
  /** The page calls window.open(url): Chrome says so, creates the window, and holds it before it starts. */
  const opensWindow = (popup: string, url: string, features: string[] = ['width=480', 'height=640', 'resizable']) => {
    connection.emit('event', { method: 'Page.windowOpen', params: { url, windowName: 'x', windowFeatures: features, userGesture: true }, sessionId: WATCH });
    connection.emit('event', { method: 'Target.targetCreated', params: { targetInfo: { targetId: popup, type: 'page', openerId: OPENER, canAccessOpener: true, url: '' } } });
    connection.emit('event', { method: 'Target.attachedToTarget', params: { sessionId: `S-${popup}`, waitingForDebugger: true, targetInfo: { targetId: popup, type: 'page', openerId: OPENER, url: '' } } });
  };
  return { connection, target, log, opened, methods, calls, settle, opensWindow };
}

afterEach(() => { vi.useRealTimers(); });

describe('windows a page opens are held until Gugu has decided, so a window Gugu does not want never asks for its address', () => {
  it('switches holding on once for the browser, for page targets only, when the first page listens for windows', async () => {
    const f = await fixture();
    const other = new PageTarget(f.connection as unknown as PipeConnection, 'T2');
    other.reportNewWindows();
    expect(f.calls('Target.setAutoAttach').map(call => call.params)).toEqual([
      { autoAttach: true, waitForDebuggerOnStart: true, flatten: true, filter: [{ type: 'page', exclude: false }, { exclude: true }] },
    ]);
  });

  it('lets a held page that no tab of Gugu opened a window for start at once, with no judgment, and drops its session', async () => {
    const f = await fixture();
    f.connection.emit('event', { method: 'Target.attachedToTarget', params: { sessionId: 'S-own', waitingForDebugger: true, targetInfo: { targetId: 'OWN', type: 'page', url: '' } } }); // A tab Gugu created: no opener.
    f.connection.emit('event', { method: 'Target.attachedToTarget', params: { sessionId: 'S-else', waitingForDebugger: true, targetInfo: { targetId: 'ELSE', type: 'page', openerId: 'not-listening', url: '' } } });
    await f.settle();
    expect(f.calls('Runtime.runIfWaitingForDebugger').map(call => call.sessionId)).toEqual(['S-own', 'S-else']);
    expect(f.calls('Target.detachFromTarget').map(call => call.params)).toEqual([{ sessionId: 'S-own' }, { sessionId: 'S-else' }]);
    expect(f.calls('Fetch.enable')).toEqual([]);
  });

  it('ignores what is not a held page: a session that is not held, and one the page itself attached', async () => {
    const f = await fixture();
    f.connection.emit('event', { method: 'Target.attachedToTarget', params: { sessionId: 'S-1', waitingForDebugger: false, targetInfo: { targetId: 'A', type: 'page', openerId: OPENER, url: '' } } });
    f.connection.emit('event', { method: 'Target.attachedToTarget', sessionId: WATCH, params: { sessionId: 'S-2', waitingForDebugger: true, targetInfo: { targetId: 'B', type: 'page', openerId: OPENER, url: '' } } });
    await f.settle();
    expect(f.calls('Runtime.runIfWaitingForDebugger')).toEqual([]);
  });

  it('lets a window a tab will show start, and does nothing else to it', async () => {
    const f = await fixture();
    f.opensWindow('P1', 'https://accounts.google.com/o/oauth2/v2/auth');
    expect(f.opened).toHaveLength(1);
    expect(f.calls('Runtime.runIfWaitingForDebugger')).toEqual([]); // Held until Gugu says.
    f.target.keepWindow('P1');
    await f.settle();
    expect(f.calls('Runtime.runIfWaitingForDebugger').map(call => call.sessionId)).toEqual(['S-P1']);
    expect(f.calls('Target.detachFromTarget').map(call => call.params)).toEqual([{ sessionId: 'S-P1' }]);
    expect(f.calls('Fetch.enable')).toEqual([]);
    expect(f.calls('Target.closeTarget')).toEqual([]);
  });

  it('stops the request of a window no tab will show before it reaches the site, then closes the window', async () => {
    const f = await fixture();
    f.opensWindow('P1', 'http://site.test/one-time-link');
    f.target.closeWindow('P1');
    await f.settle();
    // Request interception comes before the window starts, so the window cannot ask for its address first.
    expect(f.methods().filter(method => /^(Fetch\.enable|Runtime\.runIfWaitingForDebugger|Fetch\.failRequest|Target\.closeTarget)$/.test(method))).toEqual(['Fetch.enable', 'Runtime.runIfWaitingForDebugger']);
    expect(f.calls('Fetch.enable')[0]).toMatchObject({ sessionId: 'S-P1' });
    f.connection.emit('event', { method: 'Fetch.requestPaused', sessionId: 'S-P1', params: { requestId: 'R1', resourceType: 'Document', request: { url: 'http://site.test/one-time-link' } } });
    await f.settle();
    expect(f.calls('Fetch.failRequest').map(call => call.params)).toEqual([{ requestId: 'R1', errorReason: 'Aborted' }]);
    expect(f.calls('Target.closeTarget').map(call => call.params)).toEqual([{ targetId: 'P1' }]);
    expect(f.log.warn).not.toHaveBeenCalled();
  });

  it('answers only the request of the window it stopped, not another window\'s', async () => {
    const f = await fixture();
    f.opensWindow('P1', 'http://site.test/a');
    f.target.closeWindow('P1');
    await f.settle();
    f.connection.emit('event', { method: 'Fetch.requestPaused', sessionId: 'S-other', params: { requestId: 'R9' } });
    await f.settle();
    expect(f.calls('Fetch.failRequest')).toEqual([]);
    expect(f.calls('Target.closeTarget')).toEqual([]);
  });

  it('lets an empty window start and closes it: there is no request to stop', async () => {
    const f = await fixture();
    f.opensWindow('P1', 'about:blank');
    f.target.closeWindow('P1');
    await f.settle();
    expect(f.calls('Fetch.enable')).toEqual([]);
    expect(f.methods().filter(method => /^(Runtime\.runIfWaitingForDebugger|Target\.closeTarget)$/.test(method))).toEqual(['Runtime.runIfWaitingForDebugger', 'Target.closeTarget']);
  });

  it('applies a decision made before Chrome held the window when it does', async () => {
    const f = await fixture();
    f.connection.emit('event', { method: 'Page.windowOpen', params: { url: 'http://site.test/early', windowName: 'x', userGesture: true }, sessionId: WATCH });
    f.connection.emit('event', { method: 'Target.targetCreated', params: { targetInfo: { targetId: 'P1', type: 'page', openerId: OPENER, canAccessOpener: true, url: '' } } });
    f.target.keepWindow('P1'); // Decided at once, on the news of the window.
    f.connection.emit('event', { method: 'Target.attachedToTarget', params: { sessionId: 'S-P1', waitingForDebugger: true, targetInfo: { targetId: 'P1', type: 'page', openerId: OPENER, url: '' } } });
    await f.settle();
    expect(f.calls('Runtime.runIfWaitingForDebugger').map(call => call.sessionId)).toEqual(['S-P1']);
  });

  it('lets a window start as Chrome made it, and logs it, when no decision comes in time', async () => {
    vi.useFakeTimers();
    const f = await fixture();
    f.opensWindow('P1', 'http://site.test/undecided');
    await vi.advanceTimersByTimeAsync(WINDOW_DECISION_MS - 10);
    expect(f.calls('Runtime.runIfWaitingForDebugger')).toEqual([]);
    await vi.advanceTimersByTimeAsync(20);
    expect(f.calls('Runtime.runIfWaitingForDebugger').map(call => call.sessionId)).toEqual(['S-P1']);
    expect(f.log.warn).toHaveBeenCalledWith(expect.stringContaining('No decision'), { popup: 'P1' });
  });

  it('closes a window outright when it was never held, and leaves a kept one alone', async () => {
    vi.useFakeTimers();
    const f = await fixture();
    f.connection.emit('event', { method: 'Page.windowOpen', params: { url: 'http://site.test/x', windowName: 'x', userGesture: true }, sessionId: WATCH });
    f.connection.emit('event', { method: 'Target.targetCreated', params: { targetInfo: { targetId: 'P1', type: 'page', openerId: OPENER, canAccessOpener: true, url: '' } } });
    f.connection.emit('event', { method: 'Page.windowOpen', params: { url: 'http://site.test/y', windowName: 'x', userGesture: true }, sessionId: WATCH });
    f.connection.emit('event', { method: 'Target.targetCreated', params: { targetInfo: { targetId: 'P2', type: 'page', openerId: OPENER, canAccessOpener: true, url: '' } } });
    f.target.closeWindow('P1');
    f.target.keepWindow('P2');
    await vi.advanceTimersByTimeAsync(400);
    expect(f.calls('Target.closeTarget').map(call => call.params)).toEqual([{ targetId: 'P1' }]);
    expect(f.calls('Runtime.runIfWaitingForDebugger')).toEqual([]);
  });

  it('lets the window start and closes it, and logs it, when it cannot be stopped at its request', async () => {
    const f = await fixture({ failOn: 'Fetch.enable' });
    f.opensWindow('P1', 'http://site.test/a');
    f.target.closeWindow('P1');
    await f.settle();
    expect(f.log.warn).toHaveBeenCalledWith(expect.stringContaining('Could not settle'), expect.objectContaining({ popup: 'P1', fate: 'discard' }));
    expect(f.calls('Runtime.runIfWaitingForDebugger').map(call => call.sessionId)).toEqual(['S-P1']);
    expect(f.calls('Target.closeTarget').map(call => call.params)).toEqual([{ targetId: 'P1' }]);
  });

  it('closes the window, and logs it, when its request never shows up', async () => {
    vi.useFakeTimers();
    const f = await fixture();
    f.opensWindow('P1', 'http://site.test/a');
    f.target.closeWindow('P1');
    await vi.advanceTimersByTimeAsync(WINDOW_DECISION_MS + 20);
    expect(f.log.warn).toHaveBeenCalledWith(expect.stringContaining('did not stop at its request'), { popup: 'P1' });
    expect(f.calls('Target.closeTarget').map(call => call.params)).toEqual([{ targetId: 'P1' }]);
  });

  it('lets windows start that are still held when the page closes', async () => {
    const f = await fixture();
    f.opensWindow('P1', 'http://site.test/a');
    f.target.destroy();
    await f.settle();
    expect(f.calls('Runtime.runIfWaitingForDebugger').map(call => call.sessionId)).toEqual(['S-P1']);
  });

  it('does not log a held window that closed itself before it could start', async () => {
    const f = await fixture({ failOn: 'Runtime.runIfWaitingForDebugger', failWith: 'No target with given id found' });
    f.opensWindow('P1', 'http://site.test/a');
    f.target.keepWindow('P1');
    await f.settle();
    expect(f.log.warn).not.toHaveBeenCalled();
  });

  it('logs a held window that cannot be started for any other reason', async () => {
    const f = await fixture({ failOn: 'Runtime.runIfWaitingForDebugger', failWith: 'Internal error' });
    f.opensWindow('P1', 'http://site.test/a');
    f.target.keepWindow('P1');
    await f.settle();
    expect(f.log.warn).toHaveBeenCalledWith(expect.stringContaining('Could not let a held window start'), { error: 'Error: Internal error' });
  });
});
