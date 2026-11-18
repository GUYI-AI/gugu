import type { ReactNode } from 'react';

/** Picture and annotation coordinates share the captured page's viewport, including letterboxing. */
export function BrowserPictureFrame({ viewport, frame, children }: {
  viewport: { width: number; height: number };
  frame: { width: number; height: number } | null;
  children: ReactNode;
}) {
  const ratio = frame ? frame.width / frame.height : viewport.width / (viewport.height || 1);
  const width = Math.min(viewport.width, viewport.height * ratio);
  return <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2"
    style={{ width, height: ratio > 0 ? width / ratio : viewport.height }}>{children}</div>;
}
