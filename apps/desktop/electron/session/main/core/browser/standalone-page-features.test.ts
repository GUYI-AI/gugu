import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { wireStandalonePageFeatures, type FeatureHost } from './standalone-page-features';

function fixture(options: { chosen?: string[] | null; interceptFails?: boolean; adoptedWindow?: boolean } = {}) {
  const page = Object.assign(new EventEmitter(), {
    reportNewWindows: vi.fn(),
    keepWindow: vi.fn(),
    closeWindow: vi.fn(),
    adoptedWindow: options.adoptedWindow ?? false,
    announceFavicons: vi.fn(async () => undefined),
    interceptFileChoosers: vi.fn(async () => { if (options.interceptFails) throw new Error('page closed'); }),
    setFileInputFiles: vi.fn(async (_backendNodeId: number, _files: string[]) => undefined),
  });
  const host = {
    openInNewTab: vi.fn(),
    chooseFiles: vi.fn(async (_options: { multiple: boolean }) => options.chosen === undefined ? ['/tmp/a.txt'] : options.chosen),
    closeTab: vi.fn(),
    faviconsUpdated: vi.fn(),
    loadFailed: vi.fn(),
    report: vi.fn(),
  } satisfies FeatureHost;
  const ready = wireStandalonePageFeatures(page, host);
  const settle = () => new Promise(resolve => setTimeout(resolve, 5));
  return { page, host, ready, settle };
}

describe('a standalone page in the Gugu window', () => {
  // What Chrome lists for a window.open that is a tab, and for one that asked for a popup window.
  const asTab = ['menubar', 'toolbar', 'status', 'scrollbars', 'resizable'];
  const asPopup = ['width=480', 'height=640', 'resizable'];

  it('opens a new Gugu tab for a web address the page opened a window for, and for nothing else', async () => {
    const f = fixture();
    await f.ready;
    expect(f.page.reportNewWindows).toHaveBeenCalledOnce();
    for (const url of ['https://site.test/a', 'http://localhost:3000/b']) f.page.emit('window-open', { url });
    for (const url of ['javascript:alert(1)', 'about:blank', 'file:///etc/passwd', 'chrome://settings', 'not a url', 'https://site.test/\u0000x', '']) f.page.emit('window-open', { url });
    expect(f.host.openInNewTab.mock.calls.map(call => call[0])).toEqual(['https://site.test/a', 'http://localhost:3000/b']);
  });

  it('gives a sign-in address the window Chrome created for it, so the page keeps window.opener, when it asked for a popup window', async () => {
    const f = fixture();
    await f.ready;
    f.page.emit('window-open', { url: 'https://accounts.google.com/o/oauth2/v2/auth', popup: 'P1', features: asPopup, opener: true });
    f.page.emit('window-open', { url: 'https://github.com/login/oauth/authorize', popup: 'P2', features: asPopup, opener: true });
    expect(f.host.openInNewTab.mock.calls).toEqual([['https://accounts.google.com/o/oauth2/v2/auth', 'P1'], ['https://github.com/login/oauth/authorize', 'P2']]);
    expect(f.page.keepWindow.mock.calls).toEqual([['P1'], ['P2']]); // Chrome may start loading them: the tab takes them over.
    expect(f.page.closeWindow).not.toHaveBeenCalled();
  });

  it('gives any other address a tab that loads it on its own, with no window.opener, and closes the window Chrome created', async () => {
    const f = fixture();
    await f.ready;
    f.page.emit('window-open', { url: 'http://localhost:3000/p/auth', popup: 'P1', features: asPopup, opener: true }); // a popup, but not a sign-in address
    f.page.emit('window-open', { url: 'https://accounts.google.com/o/oauth2/v2/auth', popup: 'P2', features: asTab, opener: true }); // a sign-in address, but not a popup
    expect(f.host.openInNewTab.mock.calls).toEqual([['http://localhost:3000/p/auth'], ['https://accounts.google.com/o/oauth2/v2/auth']]); // No window named: the tab loads it itself.
    expect(f.page.closeWindow.mock.calls).toEqual([['P1'], ['P2']]);
    expect(f.page.keepWindow).not.toHaveBeenCalled();
  });

  it('lets a tab take the window of a link that has no window.opener anyway: the address loads once', async () => {
    const f = fixture();
    await f.ready;
    f.page.emit('window-open', { url: 'https://site.test/link', popup: 'P1', features: [...asTab, 'noopener'], opener: false });
    expect(f.host.openInNewTab.mock.calls).toEqual([['https://site.test/link', 'P1']]);
    expect(f.page.keepWindow.mock.calls).toEqual([['P1']]);
    expect(f.page.closeWindow).not.toHaveBeenCalled();
  });

  it('opens nothing for an empty window or an address that is no web page, and closes the window Chrome created', async () => {
    const f = fixture();
    await f.ready;
    f.page.emit('window-open', { url: 'about:blank', popup: 'P1', features: asTab, opener: true });
    f.page.emit('window-open', { url: 'javascript:void(0)', popup: 'P2', features: asPopup, opener: true });
    expect(f.host.openInNewTab).not.toHaveBeenCalled();
    expect(f.page.closeWindow.mock.calls).toEqual([['P1'], ['P2']]);
  });

  it('opens no tab from a sign-in window except for another sign-in window, as the built-in browser does', async () => {
    const f = fixture({ adoptedWindow: true });
    await f.ready;
    f.page.emit('window-open', { url: 'https://site.test/', popup: 'P1', features: asTab, opener: true });
    f.page.emit('window-open', { url: 'https://github.com/login', popup: 'P2', features: asPopup, opener: true });
    expect(f.host.openInNewTab.mock.calls).toEqual([['https://github.com/login', 'P2']]);
    expect(f.page.closeWindow.mock.calls).toEqual([['P1']]);
  });

  it('opens a tab by address for a window Chrome blocked, and names no window for it', async () => {
    const f = fixture();
    await f.ready;
    f.page.emit('window-open', { url: 'https://ads.test/' });
    f.page.emit('window-open', { url: 'https://github.com/login', features: asPopup });
    expect(f.host.openInNewTab.mock.calls).toEqual([['https://ads.test/'], ['https://github.com/login', undefined]]);
    expect(f.page.closeWindow).not.toHaveBeenCalled();
  });

  it('closes the tab when the page it shows closes itself, as a window does after sign-in', async () => {
    const f = fixture();
    await f.ready;
    f.page.emit('closed-by-page');
    expect(f.host.closeTab).toHaveBeenCalledOnce();
  });

  it('shows the icon the page declares in the tab, including one it declared before the tab was listening', async () => {
    const f = fixture();
    await f.ready;
    expect(f.page.announceFavicons).toHaveBeenCalledOnce();
    f.page.emit('page-favicon-updated', { favicons: ['https://site.test/fav.png'] });
    expect(f.host.faviconsUpdated).toHaveBeenCalledExactlyOnceWith(['https://site.test/fav.png']);
  });

  it('asks the person for the files an input wants and puts them in that input', async () => {
    const f = fixture({ chosen: ['/tmp/a.txt', '/tmp/b.txt'] });
    await f.ready;
    expect(f.page.interceptFileChoosers).toHaveBeenCalledOnce();
    f.page.emit('file-chooser', { multiple: true, backendNodeId: 7 });
    await f.settle();
    expect(f.host.chooseFiles).toHaveBeenCalledWith({ multiple: true });
    expect(f.page.setFileInputFiles).toHaveBeenCalledExactlyOnceWith(7, ['/tmp/a.txt', '/tmp/b.txt']);
    f.page.emit('file-chooser', { multiple: false, backendNodeId: 8 });
    await f.settle();
    expect(f.host.chooseFiles).toHaveBeenLastCalledWith({ multiple: false });
  });

  it('leaves the input alone when the person cancels or picks nothing', async () => {
    for (const chosen of [null, []]) {
      const f = fixture({ chosen });
      await f.ready;
      f.page.emit('file-chooser', { multiple: false, backendNodeId: 1 });
      await f.settle();
      expect(f.page.setFileInputFiles).not.toHaveBeenCalled();
      expect(f.host.report).not.toHaveBeenCalled();
    }
  });

  it('reports a chooser that cannot be shown or filled instead of throwing', async () => {
    const f = fixture();
    await f.ready;
    f.host.chooseFiles.mockRejectedValueOnce(new Error('no window'));
    f.page.emit('file-chooser', { multiple: false, backendNodeId: 1 });
    f.page.setFileInputFiles.mockRejectedValueOnce(new Error('node gone'));
    f.page.emit('file-chooser', { multiple: false, backendNodeId: 2 });
    await f.settle();
    expect(f.host.report).toHaveBeenCalledTimes(2);
  });

  it('reports a page it could not hand file choosers over for, and still handles windows and failed loads', async () => {
    const f = fixture({ interceptFails: true });
    await f.ready;
    expect(f.host.report).toHaveBeenCalledOnce();
    const failure = { errorCode: -202, errorDescription: 'ERR_CERT_AUTHORITY_INVALID', validatedURL: 'https://bad.test/' };
    f.page.emit('did-fail-load', failure);
    expect(f.host.loadFailed).toHaveBeenCalledExactlyOnceWith(failure);
  });
});
