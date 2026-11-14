import { browserAnnotationScript, type BrowserAnnotationQuery, type BrowserAnnotationInspection, type BrowserAnnotationTarget } from '@shared/browser-annotation';
import { browserWebContentsRegistry } from './browser-webcontents-registry';
import { snapshotBrowserPage } from './browser-page-views';

export async function inspectBrowserAnnotation(args: { browserId: string; sessionId: string; query: BrowserAnnotationQuery; capture: boolean }): Promise<BrowserAnnotationInspection> {
  const page = browserWebContentsRegistry.browsersOfSession(args.sessionId).find(page => page.browserId === args.browserId);
  if (!page || page.webContents.isDestroyed()) throw new Error('This conversation has no selected browser page');
  const target = await page.webContents.executeJavaScript(browserAnnotationScript(args.query)) as BrowserAnnotationTarget;
  if (!args.capture) return { target };
  const screenshot = await snapshotBrowserPage(args.browserId);
  if (!screenshot) throw new Error('The page screenshot could not be captured');
  if (page.webContents.isDestroyed() || page.webContents.getURL() !== target.url) throw new Error('The page changed during selection');
  return { target, screenshot };
}
