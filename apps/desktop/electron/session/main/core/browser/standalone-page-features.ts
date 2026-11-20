import { decideWindowOpen, windowOpenDisposition } from './browser-window-open';

/** The page as these host features see it (what `PageTarget` offers a desktop tab). */
export type FeaturePage = {
  on(event: 'window-open' | 'file-chooser' | 'did-fail-load' | 'closed-by-page' | 'page-favicon-updated', listener: (...args: unknown[]) => void): unknown;
  reportNewWindows(): void;
  /** Closes a window Chrome created for this page that no Gugu tab will show. */
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
    // A window of its own, or one that has no window.opener to give anyway (a link): the tab takes Chrome's window and the address loads once.
    if (decision === 'window' || (decision === 'tab' && opener === false)) return host.openInNewTab(url, window);
    // The built-in browser gives a tab no window.opener, which a window Chrome already created cannot be taken without: it goes, the tab loads the address itself.
    if (window) page.closeWindow(window);
    if (decision === 'tab') host.openInNewTab(url);
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
