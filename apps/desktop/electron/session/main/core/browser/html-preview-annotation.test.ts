import { beforeEach, describe, expect, it, vi } from 'vitest';
import { inspectHtmlPreviewAnnotation } from './html-preview-annotation';
import type { HtmlPreviewAnnotationRequest } from '@shared/preview/html-preview-annotation';

const native = vi.hoisted(() => {
  const frame = { name: 'preview-id', url: 'gugu-preview://a/index.html', detached: false, executeJavaScript: vi.fn() };
  const contents = { mainFrame: { frames: [frame] }, getURL: () => 'http://localhost:5173/', getZoomFactor: () => 1,
    capturePage: vi.fn() };
  const host = { isDestroyed: () => false, webContents: contents, getContentSize: () => [800, 600] };
  return { frame, contents, host };
});
vi.mock('./browser-page-views', () => ({ resolveBrowserHostWindow: () => native.host }));

const request: HtmlPreviewAnnotationRequest = {
  windowName: '', frameName: 'preview-id', url: 'gugu-preview://a/index.html',
  query: { x: 0.2, y: 0.3, width: 0, height: 0 }, bounds: { x: 360, y: 50, width: 440, height: 540 }, capture: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  native.frame.url = request.url;
  native.frame.executeJavaScript.mockResolvedValue({ url: request.url, text: 'Preview evidence' });
  native.contents.capturePage.mockResolvedValue({ isEmpty: () => false, toDataURL: () => 'data:image/png;base64,fixture' });
});

describe('HTML preview annotation evidence', () => {
  it('uses the named sandboxed frame and captures only its bounds', async () => {
    await expect(inspectHtmlPreviewAnnotation(request)).resolves.toMatchObject({
      target: { text: 'Preview evidence' }, screenshot: 'data:image/png;base64,fixture',
    });
    expect(native.frame.executeJavaScript).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('elementFromPoint'));
    expect(native.contents.capturePage).toHaveBeenCalledExactlyOnceWith(request.bounds, { stayHidden: true });
  });

  it('rejects arbitrary web pages, stale frames, and out-of-window bounds', async () => {
    await expect(inspectHtmlPreviewAnnotation({ ...request, url: 'https://example.org/' })).rejects.toThrow('unavailable');
    await expect(inspectHtmlPreviewAnnotation({ ...request, frameName: 'other' })).rejects.toThrow('no longer open');
    await expect(inspectHtmlPreviewAnnotation({ ...request, bounds: { ...request.bounds, y: -1 } })).rejects.toThrow('outside');
    expect(native.contents.capturePage).not.toHaveBeenCalled();
  });
});
