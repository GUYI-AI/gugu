import { browserAnnotationScript, type BrowserAnnotationInspection, type BrowserAnnotationTarget } from '@shared/browser-annotation';
import type { HtmlPreviewAnnotationRequest } from '@shared/preview/html-preview-annotation';
import { isAnnotationPreviewUrl } from '@shared/preview/html-preview-annotation';
import { resolveBrowserHostWindow } from './browser-page-views';

/** The named iframe is kept in its opaque sandbox. Only the host reads and captures its visible contents. */
export async function inspectHtmlPreviewAnnotation(args: HtmlPreviewAnnotationRequest): Promise<BrowserAnnotationInspection> {
  const host = resolveBrowserHostWindow(args.windowName);
  if (!host || host.isDestroyed() || !isAnnotationPreviewUrl(args.url, host.webContents.getURL())) {
    throw new Error('The HTML preview is unavailable');
  }
  const contents = host.webContents;
  const frame = contents.mainFrame.frames.find(child => child.name === args.frameName && child.url === args.url);
  if (!frame || frame.detached) throw new Error('The selected HTML preview is no longer open');
  const target = await frame.executeJavaScript(browserAnnotationScript(args.query)) as BrowserAnnotationTarget;
  if (!args.capture) return { target };
  if (frame.detached || frame.url !== target.url || frame.url !== args.url) throw new Error('The HTML preview changed during selection');

  const zoom = contents.getZoomFactor();
  const [maxWidth, maxHeight] = host.getContentSize();
  const { x, y, width, height } = args.bounds;
  const left = Math.floor(x * zoom), top = Math.floor(y * zoom);
  const right = Math.ceil((x + width) * zoom), bottom = Math.ceil((y + height) * zoom);
  if (![left, top, right, bottom].every(Number.isSafeInteger) || left < 0 || top < 0 ||
    right > maxWidth + 1 || bottom > maxHeight + 1 || right <= left || bottom <= top) throw new Error('The HTML preview is outside its window');

  const image = await contents.capturePage({ x: left, y: top, width: right - left, height: bottom - top }, { stayHidden: true });
  if (image.isEmpty() || frame.detached || frame.url !== args.url) throw new Error('Could not capture the HTML preview');
  return { target, screenshot: image.toDataURL() };
}
