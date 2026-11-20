import { isSupportedBrowserNavigationUrl } from './browser-navigation';

/** The page as these host features see it (what `PageTarget` offers a desktop tab). */
export type FeaturePage = {
  on(event: 'window-open' | 'file-chooser' | 'did-fail-load', listener: (...args: unknown[]) => void): unknown;
  denyNewWindows(): void;
  interceptFileChoosers(): Promise<void>;
  setFileInputFiles(backendNodeId: number, files: string[]): Promise<void>;
};

export type LoadFailure = { errorCode: number; errorDescription: string; validatedURL: string };

export type FeatureHost = {
  /** A new Gugu tab next to the one that opened it. */
  openInNewTab(url: string): void;
  /** The files the person picks for an `<input type=file>`; `null` when they cancel. */
  chooseFiles(options: { multiple: boolean }): Promise<string[] | null>;
  loadFailed(failure: LoadFailure): void;
  report(message: string, error: unknown): void;
};

/** Same rule as the built-in browser's window-open handler: only web addresses become a Gugu tab. */
function isWebAddress(url: string): boolean {
  if (!isSupportedBrowserNavigationUrl(url)) return false;
  try {
    const { protocol } = new URL(url);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * What the built-in browser does for a page in the Gugu window, on a page that lives in a headless Chrome where nothing happens
 * unless Gugu does it: a window the page opens becomes a Gugu tab, an `<input type=file>` asks the person for files over the Gugu
 * window, and a main frame that failed to load is reported as Electron's did-fail-load so Gugu's own "can't open" page covers it.
 */
export async function wireStandalonePageFeatures(page: FeaturePage, host: FeatureHost): Promise<void> {
  page.on('window-open', (...args: unknown[]) => {
    const { url } = args[0] as { url?: unknown };
    if (typeof url === 'string' && isWebAddress(url)) host.openInNewTab(url);
  });

  page.on('file-chooser', (...args: unknown[]) => {
    const { multiple, backendNodeId } = args[0] as { multiple: boolean; backendNodeId: number };
    void (async () => {
      const files = await host.chooseFiles({ multiple });
      if (!files?.length) return;
      await page.setFileInputFiles(backendNodeId, files);
    })().catch(error => host.report('Standalone browser file chooser failed', error));
  });

  page.on('did-fail-load', (...args: unknown[]) => host.loadFailed(args[0] as LoadFailure));

  page.denyNewWindows();
  try {
    await page.interceptFileChoosers();
  } catch (error) {
    host.report('Standalone browser could not take over file choosers', error);
  }
}
