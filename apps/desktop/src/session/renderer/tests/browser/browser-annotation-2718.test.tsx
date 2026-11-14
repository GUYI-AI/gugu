import { afterEach, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import { browserAnnotationScript, type BrowserAnnotationTarget } from '@shared/browser-annotation';
import { markedAnnotationScreenshot } from '@renderer/features/browser/annotation-screenshot';

let fixture: HTMLDivElement | null = null;
afterEach(() => { fixture?.remove(); fixture = null; });

it('reads an actual selected element and rectangular text without activating the page', async () => {
  await page.viewport(800, 600);
  fixture = document.createElement('div');
  fixture.style.cssText = 'position:fixed;inset:0;background:white;color:black;z-index:99999';
  fixture.innerHTML = '<main style="padding:40px"><p id="intro" style="margin:0;height:40px">Exact selected text</p><button id="action" style="height:40px">Page action</button><p style="margin-top:100px">Outside selection</p></main>';
  document.body.append(fixture);
  let activated = 0;
  fixture.querySelector('button')!.addEventListener('click', () => activated++);
  const target = globalThis.eval(browserAnnotationScript({ x: 0.1, y: 0.09, width: 0, height: 0 })) as BrowserAnnotationTarget;
  expect(target.text).toBe('Exact selected text');
  expect(target.selector).toBe('#intro');
  expect(target.viewport).toMatchObject({ width: 800, height: 600 });
  const selected = globalThis.eval(browserAnnotationScript({ x: 0.04, y: 0.05, width: 0.8, height: 0.17 })) as BrowserAnnotationTarget;
  expect(selected.text).toContain('Exact selected text');
  expect(selected.text).toContain('Page action');
  expect(selected.text).not.toContain('Outside selection');
  expect(selected.selector).toBeNull();
  expect(activated).toBe(0);
});

it('creates an actual PNG with the selected region and reference number at capture resolution', async () => {
  const canvas = document.createElement('canvas'); canvas.width = 800; canvas.height = 600;
  const context = canvas.getContext('2d')!; context.fillStyle = '#fff'; context.fillRect(0, 0, 800, 600);
  const screenshot = await markedAnnotationScreenshot(canvas.toDataURL(), { url: 'https://example.org/', selector: null, targetPath: null, text: 'Evidence',
    rect: { x: 40, y: 30, width: 100, height: 50 }, viewport: { width: 400, height: 300, scrollX: 0, scrollY: 0 } }, 3);
  expect(screenshot.name).toBe('browser-comment-3.png');
  expect(screenshot.type).toBe('image/png');
  const image = await createImageBitmap(screenshot);
  expect([image.width, image.height]).toEqual([800, 600]);
  context.drawImage(image, 0, 0);
  expect([...context.getImageData(100, 60, 1, 1).data]).not.toEqual([255, 255, 255, 255]);
  expect([...context.getImageData(400, 400, 1, 1).data]).toEqual([255, 255, 255, 255]);
  image.close();
});
