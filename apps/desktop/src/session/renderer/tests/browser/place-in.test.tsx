/**
 * @@@placed-surface — a host put in another box keeps what is in it: its scroll, its frames.
 */
import { expect, it } from 'vitest';
import { placeIn, surfaceHost } from '@renderer/lib/layout/place-in';

it('a host moved from one box to another keeps its scroll position and does not reload its frame', async () => {
  const [a, b] = [document.createElement('div'), document.createElement('div')];
  document.body.append(a, b);
  const host = surfaceHost('');
  host.innerHTML = '<div data-list style="height:100px;overflow:auto"><div style="height:2000px"></div></div><iframe srcdoc="<p>frame</p>"></iframe>';
  placeIn(host, a);
  const list = host.querySelector<HTMLElement>('[data-list]')!;
  const frame = host.querySelector('iframe')!;
  await new Promise((resolve) => frame.addEventListener('load', resolve, { once: true }));
  let loads = 0;
  frame.addEventListener('load', () => { loads += 1; });
  list.scrollTop = 700;
  placeIn(host, b);
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(host.parentElement).toBe(b);
  expect(list.scrollTop).toBe(700);
  expect(loads).toBe(0);
  a.remove(); b.remove();
});
