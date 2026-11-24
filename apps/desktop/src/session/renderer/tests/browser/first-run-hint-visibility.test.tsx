import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it } from 'vitest';
import { useFirstRunHintTargets, type HintDevice, type HintTarget } from '@/components/firstRun/firstRunHintTargets';

// The hint locator asks the rendering step (IntersectionObserver) whether an entry is on screen, in real Chromium.
const cleanup: Array<() => void> = [];
afterEach(() => cleanup.splice(0).reverse().forEach((stop) => stop()));

function mountProbe(seen: { targets: readonly HintTarget[] }, device: HintDevice = 'desktop') {
  const host = document.createElement('div');
  document.body.append(host);
  const root: Root = createRoot(host);
  function Probe() { seen.targets = useFirstRunHintTargets(device, true); return null; }
  act(() => root.render(<Probe />));
  cleanup.push(() => { act(() => root.unmount()); host.remove(); });
}

function addEntry(): void {
  const surface = document.createElement('section');
  surface.style.position = 'relative';
  const entry = document.createElement('div');
  entry.dataset.rail = 'assistant';
  entry.textContent = 'Assistant';
  entry.style.cssText = 'width: 120px; height: 24px';
  surface.append(entry);
  document.body.append(surface);
  cleanup.push(() => surface.remove());
}

// 界面减法 #51: the assistant's entry moved into my menu (closed until opened), so no device has a place to draw a hint
// by: an entry on screen is never a target.
it.each(['phone', 'desktop'] as const)('has no hint targets on the %s when the observer is enabled', async (device) => {
  const seen = { targets: [] as readonly HintTarget[] };
  addEntry();
  mountProbe(seen, device);
  await new Promise((resolve) => requestAnimationFrame(resolve));
  expect(seen.targets).toEqual([]);
});
