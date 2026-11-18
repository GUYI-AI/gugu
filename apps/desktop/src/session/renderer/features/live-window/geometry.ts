import type { LiveWindowSize } from './types';

export function validLiveWindowSize(size: LiveWindowSize | null | undefined): size is LiveWindowSize {
  return !!size && Number.isFinite(size.width) && Number.isFinite(size.height) && size.width > 0 && size.height > 0;
}

/** Fit the whole source, with one scale for both axes. Unknown geometry has no invented fallback. */
export function fitLiveWindow(source: LiveWindowSize | null, available: LiveWindowSize): (LiveWindowSize & {
  scale: number; left: number; top: number;
}) | null {
  if (!validLiveWindowSize(source) || !validLiveWindowSize(available)) return null;
  const scale = Math.min(available.width / source.width, available.height / source.height);
  const width = source.width * scale, height = source.height * scale;
  return { width, height, scale, left: (available.width - width) / 2, top: (available.height - height) / 2 };
}
