import { browserAnnotationScript, type AnnotationConversation, type BrowserAnnotationQuery, type BrowserAnnotationInspection, type BrowserAnnotationTarget } from '@shared/browser-annotation';
import { browserWebContentsRegistry } from './browser-webcontents-registry';
import { snapshotBrowserPage } from './browser-page-views';

export async function inspectBrowserAnnotation(args: { browserId: string; conversation: AnnotationConversation; query: BrowserAnnotationQuery; capture: boolean }): Promise<BrowserAnnotationInspection> {
  const page = browserWebContentsRegistry.browserForConversation(args.browserId, args.conversation);
  if (!page) throw new Error('This conversation has no selected browser page');
  const target = await page.executeJavaScript(browserAnnotationScript(args.query)) as BrowserAnnotationTarget;
  if (browserWebContentsRegistry.browserForConversation(args.browserId, args.conversation) !== page) throw new Error('The page changed conversations during selection');
  if (!args.capture) return { target };
  const screenshot = await snapshotBrowserPage(args.browserId);
  if (!screenshot) throw new Error('The page screenshot could not be captured');
  if (page.isDestroyed() || page.getURL() !== target.url || browserWebContentsRegistry.browserForConversation(args.browserId, args.conversation) !== page) throw new Error('The page changed during selection');
  return { target, screenshot };
}
