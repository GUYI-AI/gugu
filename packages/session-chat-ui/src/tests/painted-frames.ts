/**
 * Read the page once per frame as that frame paints it: a ResizeObserver delivers after the frame's animation
 * callbacks (the transcript's own read/write phases) and its layout, before paint. A probe resized in every frame
 * makes it deliver every frame. A read in a requestAnimationFrame callback would see the state before the write phase.
 */
export function paintedFrames<T>(read: () => T | undefined): { frames: T[]; stop: () => void } {
  const frames: T[] = [];
  const probe = document.createElement('div');
  probe.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;pointer-events:none';
  document.body.append(probe);
  let on = true;
  const observer = new ResizeObserver(() => { if (!on) return; const value = read(); if (value !== undefined) frames.push(value); });
  observer.observe(probe);
  const tick = () => { if (!on) return; probe.style.width = probe.style.width === '1px' ? '2px' : '1px'; requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  return { frames, stop: () => { on = false; observer.disconnect(); probe.remove(); } };
}
