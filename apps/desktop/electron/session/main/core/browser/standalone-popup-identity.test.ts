import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { createServerTaskBrowser, type PageTarget, type PipeConnection } from '../../../../server/server-task-browser';
import { TaskPopupClosed } from '../../../../server/task-popups';

vi.mock('@gugu/core/local/state/agentFileBoundary', () => ({ requireAgentFileTreeAccess: async () => {} }));

/** A Chrome that creates pages on request and reports what a page's `window.open` does, as the real one does. */
function chrome() {
  const connection = Object.assign(new EventEmitter(), {
    closed: null,
    created: [] as string[],
    closedTargets: [] as string[],
    /** Pages that are gone: Chrome has no such target any more, whether or not it has said so yet. */
    gone: new Set<string>(),
    sessions: new Map<string, string>(),
    send: vi.fn(async (method: string, params: Record<string, unknown> = {}, sessionId?: string) => {
      if (method === 'Target.createTarget') {
        const targetId = `T${connection.created.length + 1}`;
        connection.created.push(targetId);
        return { targetId };
      }
      if (method === 'Target.closeTarget') { connection.closedTargets.push(String(params.targetId)); return { success: true }; }
      if (method === 'Target.attachToTarget') {
        if (connection.gone.has(String(params.targetId))) throw new Error('No target with given id found');
        const sessionId = `S-${String(params.targetId)}`;
        connection.sessions.set(String(params.targetId), sessionId);
        return { sessionId };
      }
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main', url: 'about:blank' } } };
      if (method === 'Page.getNavigationHistory') return { currentIndex: 0, entries: [{ id: 1, url: 'about:blank' }] };
      if (method === 'Target.getTargetInfo') return { targetInfo: { targetId: String(params.targetId), url: '', title: '' } };
      return {};
    }),
    /** The page `opener` calls `window.open(address)`: Chrome says so, then creates the window's page. */
    windowOpens(opener: string, popup: string, address = '') {
      connection.emit('event', { method: 'Page.windowOpen', params: { url: address, windowName: '_blank', userGesture: true }, sessionId: connection.sessions.get(opener) });
      connection.emit('event', { method: 'Target.targetCreated', params: { targetInfo: { targetId: popup, type: 'page', openerId: opener, url: '' } } });
    },
    pageCloses(targetId: string) { connection.emit('event', { method: 'Target.targetDestroyed', params: { targetId } }); },
  });
  const browser = createServerTaskBrowser({
    binary: () => null,
    profile: '/unused',
    spawn: () => ({ process: { pid: 1, exitCode: null, signalCode: null, kill: vi.fn() } as unknown as ChildProcess, connection: connection as unknown as PipeConnection }),
    log: { info: vi.fn(), warn: vi.fn() },
  });
  const signal = new AbortController().signal;
  const open = (tab: string, url?: string, popup?: string) => (browser.pageFor as (...args: unknown[]) => Promise<PageTarget>)(tab, url, signal, popup);
  return { connection, browser, open };
}

/** A tab whose page opened an empty window, which is about:blank until the page sends it somewhere. */
async function withBlankWindow() {
  const f = chrome();
  const opener = await f.open('opener', 'http://site.test/');
  opener.reportNewWindows();
  f.connection.windowOpens(opener.targetId, 'POPUP');
  return { ...f, opener };
}

describe('a window a page opened is taken by the tab Gugu opened for it, not by whichever tab shows the same address', () => {
  it('a blank tab the person opens does not take the empty window, which goes to the tab opened for it', async () => {
    const f = await withBlankWindow();
    const personsTab = await f.open('persons-blank-tab', 'about:blank');
    expect(personsTab.targetId).not.toBe('POPUP');
    expect(f.connection.created).toEqual(['T1', 'T2']); // The person's tab got a page of its own.
    const windowsTab = await f.open('windows-tab', 'about:blank', 'POPUP');
    expect(windowsTab.targetId).toBe('POPUP');
    expect(f.connection.created).toEqual(['T1', 'T2']); // Taking the window created nothing.
    expect(f.connection.closedTargets).toEqual([]);
  });

  it('the same when the tab opened for the window comes first', async () => {
    const f = await withBlankWindow();
    const windowsTab = await f.open('windows-tab', 'about:blank', 'POPUP');
    const personsTab = await f.open('persons-blank-tab', 'about:blank');
    expect(windowsTab.targetId).toBe('POPUP');
    expect(personsTab.targetId).not.toBe('POPUP');
    expect(f.connection.created).toEqual(['T1', 'T2']);
  });

  it('two empty windows go to their own tabs in whatever order the tabs ask', async () => {
    const f = chrome();
    const opener = await f.open('opener', 'http://site.test/');
    opener.reportNewWindows();
    f.connection.windowOpens(opener.targetId, 'P1');
    f.connection.windowOpens(opener.targetId, 'P2');
    expect((await f.open('tab-2', 'about:blank', 'P2')).targetId).toBe('P2');
    expect((await f.open('tab-1', 'about:blank', 'P1')).targetId).toBe('P1');
  });

  it('a window that closed itself before its tab opened closes that tab, and never one the person opened', async () => {
    const f = await withBlankWindow();
    f.connection.pageCloses('POPUP');
    const personsTab = await f.open('persons-blank-tab', 'about:blank');
    expect(personsTab.targetId).not.toBe('POPUP');
    await expect(f.open('windows-tab', 'about:blank', 'POPUP')).rejects.toBeInstanceOf(TaskPopupClosed);
  });

  it('a window that closes itself just as its tab takes it closes that tab too, and its address is not loaded again', async () => {
    const f = await withBlankWindow();
    f.connection.gone.add('POPUP'); // Chrome already closed it; the news has not reached Gugu.
    await expect(f.open('windows-tab', 'https://auth.test/login', 'POPUP')).rejects.toBeInstanceOf(TaskPopupClosed);
    expect(f.connection.created).toEqual(['T1']); // No page was created to load the address.
  });

  it('a tab that knows no window opens the address itself, as a tab of another profile has to', async () => {
    const f = await withBlankWindow();
    const other = await f.open('other-profile-tab', 'http://auth.test/login', 'NOT-HELD-HERE');
    expect(other.targetId).not.toBe('POPUP');
    expect(f.connection.created).toEqual(['T1', 'T2']);
  });
});
