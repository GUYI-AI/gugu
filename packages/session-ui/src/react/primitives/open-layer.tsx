import { useEffect } from 'react';

let mounted = 0;

/**
 * Drawn inside a floating layer's positioner (popover, menu, select, combobox), which Base UI mounts only while the layer
 * is up: while any is, `<html>` carries `data-layer-open` and nothing in the window drags, so a click on the rail or the
 * title bar reaches the page and closes it (@@@open-layer-no-drag, apps/desktop/src/styles/tokens.css).
 */
export function OpenLayer(): null {
  useEffect(() => {
    const root = document.documentElement;
    if (mounted++ === 0) root.setAttribute('data-layer-open', '');
    return () => { if (--mounted === 0) root.removeAttribute('data-layer-open'); };
  }, []);
  return null;
}
