import { decideWindowOpen, windowOpenDisposition } from './browser-window-open';

/** The page as these host features see it (what `PageTarget` offers a desktop tab). */
export type FeaturePage = {
  on(event: 'window-open' | 'file-chooser' | 'did-fail-load' | 'closed-by-page' | 'page-favicon-updated', listener: (...args: unknown[]) => void): unknown;
  reportNewWindows(): void;
  /** A Gugu tab will show a window Chrome created for this page: it may start loading. */
  keepWindow(popup: string): void;
  /** No Gugu tab will show a window Chrome created for this page: it is closed, if possible before it asks for its address. */
  closeWindow(popup: string): void;
  /** This page is itself a window another page opened. */
  readonly adoptedWindow?: boolean;
  announceFavicons(): Promise<void>;
  interceptFileChoosers(): Promise<void>;
  setFileInputFiles(backendNodeId: number, files: string[]): Promise<void>;
};

export type LoadFailure = { errorCode: number; errorDescription: string; validatedURL: string };

export type FeatureHost = {
  /** A new Gugu tab next to the one that opened it. `popup` names the window Chrome already created for it, which the tab shows. */
  openInNewTab(url: string, popup?: string): void;
  /**
   * A tab opened for a link of this page is a standalone tab in the same Chrome as this page, so it can take a window this page's
   * Chrome created. It is not when the person's default profile is another one (another Chrome process), or the engine setting
   * has changed since this tab opened.
   */
  newTabSharesBrowser(): Promise<boolean>;
  /** The files the person picks for an `<input type=file>`; `null` when they cancel. */
  chooseFiles(options: { multiple: boolean }): Promise<string[] | null>;
  /** The page this tab shows closed itself (window.close()): the tab goes with it. */
  closeTab(): void;
  faviconsUpdated(favicons: string[]): void;
  loadFailed(failure: LoadFailure): void;
  report(message: string, error: unknown): void;
};

/**
 * What the built-in browser does for a page in the Gugu window, on a page that lives in a headless Chrome where nothing happens
 * unless Gugu does it: a window the page opens becomes a Gugu tab by the built-in browser's rule (a sign-in window is adopted so it keeps
 * `window.opener`; the page's own `window.close()` closes the tab), an `<input type=file>` asks the person for files over the Gugu
 * window, a main frame that failed to load is reported as Electron's did-fail-load so Gugu's own "can't open" page covers it, and
 * the page's icon is shown in the tab.
 */
export async function wireStandalonePageFeatures(page: FeaturePage, host: FeatureHost): Promise<void> {
  page.on('window-open', (...args: unknown[]) => {
    const { url, popup, features, opener } = args[0] as { url?: unknown; popup?: unknown; features?: string[]; opener?: boolean };
    if (typeof url !== 'string') return;
    // The built-in browser's rule, not another one: a sign-in address gets a window of its own, any other web address a tab.
    const decision = decideWindowOpen({ url, disposition: windowOpenDisposition(features), fromPopup: page.adoptedWindow === true });
    const window = typeof popup === 'string' ? popup : undefined;
    void (async () => {
      // A window of its own, or one that has no window.opener to give anyway (a link): the tab takes Chrome's window and the address loads once.
      let adopt = decision === 'window' || (decision === 'tab' && opener === false);
      // A link's tab opens where the person's settings say, which may be another Chrome than this page's: it cannot take this window.
      // When that cannot be told, the window is not taken: it goes and the tab loads the address itself, which is right either way.
      if (adopt && decision === 'tab' && window && !await host.newTabSharesBrowser().catch(error => { host.report('Standalone browser could not tell where a new tab opens', error); return false; })) adopt = false;
      if (adopt) {
        if (window) page.keepWindow(window);
        return host.openInNewTab(url, window);
      }
      // The built-in browser gives a tab no window.opener, which a window Chrome already created cannot be taken without: it goes, the tab loads the address itself.
      if (window) page.closeWindow(window);
      if (decision === 'tab') host.openInNewTab(url);
    })().catch(error => host.report('Standalone browser could not open a window of a page', error));
  });

  page.on('closed-by-page', () => host.closeTab());
  page.on('page-favicon-updated', (...args: unknown[]) => host.faviconsUpdated((args[0] as { favicons: string[] }).favicons));

  page.on('file-chooser', (...args: unknown[]) => {
    const { multiple, backendNodeId } = args[0] as { multiple: boolean; backendNodeId: number };
    void (async () => {
      const files = await host.chooseFiles({ multiple });
      if (!files?.length) return;
      await page.setFileInputFiles(backendNodeId, files);
    })().catch(error => host.report('Standalone browser file chooser failed', error));
  });

  page.on('did-fail-load', (...args: unknown[]) => host.loadFailed(args[0] as LoadFailure));

  page.reportNewWindows();
  void page.announceFavicons().catch(() => undefined);
  try {
    await page.interceptFileChoosers();
  } catch (error) {
    host.report('Standalone browser could not take over file choosers', error);
  }
}
