import { useCallback, type RefObject } from 'react';
import { desktopIpc } from '@/platform/desktopIpc';
import { useBrowserAnnotations, type InspectAnnotation } from '@renderer/features/browser/browser-annotations';
import { rpc } from '@renderer/lib/ipc';
import { PREVIEW_ANNOTATION_SPACE_RELEASE } from '@shared/preview/html-preview-annotation';

export type HtmlPreviewAnnotationContext = { sessionId: string; path: string; toolbar?: HTMLElement | null };

export function useHtmlPreviewAnnotations({ context, root, frames, source, ready, id }: {
  context?: HtmlPreviewAnnotationContext;
  root: RefObject<HTMLDivElement | null>;
  frames: RefObject<Map<string, HTMLIFrameElement>>;
  source: string;
  ready: boolean;
  id: string;
}) {
  const inspect = useCallback<InspectAnnotation>(async (query, capture) => {
    const frame = frames.current.get(source);
    const win = frame?.ownerDocument.defaultView;
    if (!frame || !win || !context) throw new Error('The HTML preview is unavailable');
    const layers = capture ? Array.from(root.current?.querySelectorAll<HTMLElement>('[data-browser-annotation-layer], [data-browser-annotation-controls]') ?? []) : [];
    const previous = layers.map(layer => layer.style.opacity);
    for (const layer of layers) layer.style.opacity = '0';
    try {
      if (layers.length) await new Promise<void>(resolve => win.requestAnimationFrame(() => win.requestAnimationFrame(() => resolve())));
      const { x, y, width, height } = frame.getBoundingClientRect();
      const result = await rpc.browser.inspectHtmlPreviewAnnotation({
        windowName: win.name, frameName: frame.name, url: source, bounds: { x, y, width, height }, query, capture,
      });
      return { ...result, target: { ...result.target, url: context.path } };
    } finally {
      layers.forEach((layer, index) => { layer.style.opacity = previous[index]; });
    }
  }, [context, frames, root, source]);
  const subscribeSpaceRelease = useCallback((release: () => void) => {
    const win = root.current?.ownerDocument.defaultView;
    const handler = (event: MessageEvent) => {
      if (event.source === frames.current.get(source)?.contentWindow && event.data?.type === PREVIEW_ANNOTATION_SPACE_RELEASE) release();
    };
    win?.addEventListener('message', handler);
    return () => win?.removeEventListener('message', handler);
  }, [frames, root, source]);
  return useBrowserAnnotations({
    sessionId: context?.sessionId,
    browserId: `html-preview:${context?.path ?? id}`,
    visible: true,
    available: ready && !!context && !!desktopIpc(),
    inspect,
    filePath: context?.path,
    subscribeSpaceRelease,
  });
}
