import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { wireStandalonePageFeatures, type FeatureHost } from './standalone-page-features';

function fixture(options: { chosen?: string[] | null; interceptFails?: boolean } = {}) {
  const page = Object.assign(new EventEmitter(), {
    reportNewWindows: vi.fn(),
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
  it('opens a new Gugu tab for a web address the page opened a window for, and for nothing else', async () => {
    const f = fixture();
    await f.ready;
    expect(f.page.reportNewWindows).toHaveBeenCalledOnce();
    for (const url of ['https://site.test/a', 'http://localhost:3000/b']) f.page.emit('window-open', { url });
    for (const url of ['javascript:alert(1)', 'about:blank', 'file:///etc/passwd', 'chrome://settings', 'not a url', 'https://site.test/\u0000x', '']) f.page.emit('window-open', { url });
    expect(f.host.openInNewTab.mock.calls.map(call => call[0])).toEqual(['https://site.test/a', 'http://localhost:3000/b']);
  });

  it('opens a tab for a window Chrome already created, including one that opens empty, so the tab can take it over', async () => {
    const f = fixture();
    await f.ready;
    f.page.emit('window-open', { url: 'https://auth.test/login', popup: 'P1' });
    f.page.emit('window-open', { url: 'about:blank', popup: 'P2' });
    f.page.emit('window-open', { url: 'javascript:void(0)', popup: 'P3' }); // Not an address a tab can open: Chrome's window is closed unclaimed.
    expect(f.host.openInNewTab.mock.calls.map(call => call[0])).toEqual(['https://auth.test/login', 'about:blank']);
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
