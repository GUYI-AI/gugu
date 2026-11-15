import { createRoot, type Root } from 'react-dom/client';
import { useSyncExternalStore } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { page, cdp } from 'vitest/browser';
import '@/styles/tokens.css';
import '@renderer/index.css';
import { DesktopLiveWindow } from '../../features/live-window/DesktopLiveWindow';
import { LiveWindowModel } from '../../features/live-window/model';

let root: Root | null = null, host: HTMLDivElement | null = null;
afterEach(() => { root?.unmount(); host?.remove(); root = null; host = null; });
it('only reveals desktop controls on hover, keeps the full portrait source, and requires its enlarge button', async () => {
  await page.viewport(1440, 960);
  const model = new LiveWindowModel('desktop');
  const context = { conversationId: 'chat', deviceId: 'device', sessionId: 'session', agentId: 'agent', privateAgentChat: true, shown: true };
  const source = { ...context, id: 'screen', kind: 'computer' as const, title: 'Actual portrait window', size: { width: 723, height: 960 }, status: 'operating' as const };
  model.activate(context); model.observe(context, [source]);
  const input = vi.fn();
  function Harness() {
    const snapshot = useSyncExternalStore(model.subscribe, model.getSnapshot, model.getSnapshot);
    return <DesktopLiveWindow source={{ ...source, picture: <button style={{ width: '100%', height: '100%' }} onClick={input}>Picture</button> }} state={snapshot.presentation!} dispatch={action => model.dispatch(action)} />;
  }
  host = document.createElement('div'); host.className = 'gugu-skin emlight'; host.style.cssText = 'position:relative;width:1000px;height:800px';
  document.body.append(host); root = createRoot(host); root.render(<Harness />);
  await vi.waitFor(() => expect(host!.querySelector('[data-live-window-picture]')?.getBoundingClientRect().width ?? 0).toBeGreaterThan(0));
  const picture = () => host!.querySelector<HTMLElement>('[data-live-window-picture]')!;
  // Chromium lays out fractional CSS pixels on a 1/64 px grid. Reject a visible distortion, not that rounding.
  const proportional = () => {
    const box = picture().getBoundingClientRect();
    expect(Math.abs(box.width - box.height * 723 / 960)).toBeLessThan(1 / 32);
  };
  proportional();
  const small = host.querySelector<HTMLElement>('[data-live-window="floating"]')!;
  await cdp().send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1, y: 1 });
  const enlarge = host.querySelector<HTMLButtonElement>('button[aria-label="Enlarge"],button[aria-label="放大"]')!;
  expect(getComputedStyle(enlarge.parentElement!).visibility).toBe('hidden');
  await page.elementLocator(small).hover();
  expect(getComputedStyle(enlarge.parentElement!).visibility).toBe('visible');
  await page.elementLocator(picture()).click({ position: { x: 10, y: 10 }, force: true });
  expect(input).not.toHaveBeenCalled(); expect(model.getSnapshot().presentation?.mode).toBe('floating');
  await page.elementLocator(enlarge).click();
  await vi.waitFor(() => expect(model.getSnapshot().presentation?.mode).toBe('enlarged'));
  proportional();
  await page.elementLocator(host.querySelector<HTMLButtonElement>('button:not([aria-label])')!).click();
  expect(input).toHaveBeenCalledTimes(1);
  model.dispatch({ type: 'composer-focus' });
  await vi.waitFor(() => expect(host!.querySelector('[data-live-window="floating"]')).not.toBeNull());
  proportional();
});
