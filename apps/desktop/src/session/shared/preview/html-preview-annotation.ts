import type { BrowserAnnotationQuery } from '../browser-annotation';
import { PREVIEW_SCHEME } from './preview-url';

export type HtmlPreviewAnnotationRequest = {
  windowName: string;
  frameName: string;
  url: string;
  query: BrowserAnnotationQuery;
  bounds: { x: number; y: number; width: number; height: number };
  capture: boolean;
};

export const HTML_PREVIEW_ANNOTATION_CHANNEL = 'gugu:html-preview-annotation';
export const PREVIEW_ANNOTATION_SPACE_RELEASE = 'gugu-preview-annotation-space-release';

export function isAnnotationPreviewUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === `${PREVIEW_SCHEME}:` && !!url.hostname;
  } catch {
    return false;
  }
}
