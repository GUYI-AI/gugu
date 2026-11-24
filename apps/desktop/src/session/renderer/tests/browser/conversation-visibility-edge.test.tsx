import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it } from 'vitest';
import { useConversationVisibility } from '@/components/chat/useConversationVisibility';

let root: Root | null = null, host: HTMLDivElement | null = null;
afterEach(() => { root?.unmount(); host?.remove(); root = null; host = null; });

const frames = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 50))));

// A slot first seen exactly on its list's edge intersects with zero area; scrolled into full view, it is shown.
it('shows a slot scrolled into view from exactly the edge of its list', async () => {
  let shown = false;
  function Slot() {
    const visibility = useConversationVisibility(true);
    shown = visibility.shown;
    return <div ref={visibility.ref} style={{ height: 120 }} />;
  }
  host = document.createElement('div');
  host.style.cssText = 'position:fixed;top:0;left:0;width:300px;height:200px;overflow:auto';
  document.body.append(host);
  root = createRoot(host);
  // Below the view first, so the edge is reached as an entry of its own.
  await act(async () => root!.render(<><div style={{ height: 500 }} /><Slot /><div style={{ height: 600 }} /></>));
  await frames();
  expect(shown).toBe(false);
  host.scrollTop = 300;
  await frames();
  expect(Math.round(host.querySelector<HTMLElement>('div > div:nth-child(2)')!.getBoundingClientRect().top)).toBe(200);
  expect(shown).toBe(false);
  host.scrollTop = 400;
  await expect.poll(() => shown).toBe(true);
});
