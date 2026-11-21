/**
 * The Apps page's header sits in the window's top band, edge to edge. Where the window controls are drawn over the content
 * (Linux), its last button (Installed) must end before them: the header reserves `--titlebar-controls-width`, the one
 * width every surface in that band reads. Real Chromium, the real stylesheet.
 */
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it } from 'vitest';
import { until } from '../../../../../../../tests/support/awaitCondition';
import '@/styles/tokens.css';
import '@renderer/index.css';
import '@renderer/features/extensions/panel/app-store.css';

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  root?.unmount();
  host?.remove();
  root = null;
  host = null;
  document.documentElement.style.removeProperty('--titlebar-controls-width');
});

async function installedButtonRight(width: number, controls: number) {
  document.documentElement.style.setProperty('--titlebar-controls-width', `${controls}px`);
  host = document.createElement('div');
  host.className = 'emlight gugu-skin';
  host.style.width = `${width}px`;
  document.body.appendChild(host);
  root = createRoot(host);
  root.render(
    <div className="mk">
      <div className="mk-bar mk-market-header">
        <div style={{ width: 300 }}>tabs</div>
        <div className="mk-market-actions">
          <input style={{ width: 180 }} />
          <button data-testid="extensions-open-installed" style={{ width: 80 }}>Installed</button>
        </div>
      </div>
    </div>
  );
  await until('header rendered', () => host!.querySelector('[data-testid="extensions-open-installed"]') !== null);
  return host.querySelector('[data-testid="extensions-open-installed"]')!.getBoundingClientRect().right - host.getBoundingClientRect().left;
}

it.each([1280, 1920])('at %ipx the Installed button ends before the window controls', async (width) => {
  expect(await installedButtonRight(width, 138)).toBeLessThanOrEqual(width - 138);
});

it('reserves nothing where the controls are not over the content (mac, Windows, web)', async () => {
  expect(await installedButtonRight(1280, 0)).toBe(1280);
});
