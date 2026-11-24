import { afterEach, expect, it } from 'vitest';
import { clippedElementBox } from '@/lib/elementVisibility';

afterEach(() => { document.body.replaceChildren(); });

function mount(overflow: string) {
  document.body.innerHTML = `<div id="parent" style="position:fixed;left:100px;top:100px;width:200px;height:200px;overflow:${overflow}">
    <div id="child" style="position:absolute;left:-20px;top:-10px;width:240px;height:100px"></div></div>`;
  const child = document.getElementById('child')!;
  return clippedElementBox(child, { left: 0, top: 0, width: innerWidth, height: innerHeight }).clip;
}

// The chat workspace's pages clip sideways only (two cards): the tool card's body reaches 10px above that box to meet its
// strip, and a page placed over it (Files, an App) must keep those 10px — the clip follows each axis as CSS does.
it('clips only the axes whose overflow clips', () => {
  expect(mount('clip visible')).toMatchObject({ left: 100, top: 90, width: 200, height: 100 });
  expect(mount('visible clip')).toMatchObject({ left: 80, top: 100, width: 240, height: 90 });
  expect(mount('clip')).toMatchObject({ left: 100, top: 100, width: 200, height: 90 });
  expect(mount('visible')).toMatchObject({ left: 80, top: 90, width: 240, height: 100 });
});
