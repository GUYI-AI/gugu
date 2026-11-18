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

export const PREVIEW_ANNOTATION_SPACE_RELEASE = 'gugu-preview-annotation-space-release';

export function isAnnotationPreviewUrl(value: string, hostUrl: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === `${PREVIEW_SCHEME}:` || (url.protocol === 'blob:' && url.origin === new URL(hostUrl).origin && url.origin !== 'null');
  } catch {
    return false;
  }
}
