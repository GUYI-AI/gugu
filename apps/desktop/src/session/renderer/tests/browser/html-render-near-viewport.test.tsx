/**
 * An html-render page in a chat bubble runs only while it is near the screen, and its box never jumps. Through the real
 * Markdown, CSS and a real sandboxed frame, in a scrolling list: words before and after the fence stay words; the frame
 * mounts in view, unmounts once scrolled 4000 px away, and mounts again on the way back, while the box keeps one height
 * from its first report on. A fence whose header declares the height (html_preview's) opens at it before the page runs.
 */
import { Markdown } from '@/components/markdown/Markdown';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it } from 'vitest';
import { until } from '../../../../../../../tests/support/awaitCondition';
import '@/styles/tokens.css';
import '@renderer/index.css';
import '@gugu/session-shared/markdown.css';

// 300 px of content plus the base sheet's 8 px padding above and below.
const PAGE = '<div style="height:300px;background:var(--c1)">chart</div>';
const PAGE_HEIGHT = 316;

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).reverse().forEach(cleanup => cleanup()));

function list(content: string) {
  const scroller = document.body.appendChild(document.createElement('div'));
  scroller.style.cssText = 'position:fixed;top:0;left:0;width:600px;height:600px;overflow:auto';
  const bubble = scroller.appendChild(document.createElement('div'));
  const spacer = scroller.appendChild(document.createElement('div'));
  spacer.style.height = '6000px';
  const root = createRoot(bubble);
  cleanups.push(() => { root.unmount(); scroller.remove(); });
  root.render(<Markdown trust="chat" content={content} />);
  const box = () => scroller.querySelector<HTMLElement>('.gg-md-html-render');
  const heights: number[] = [];
  return { scroller, bubble, box, heights, frame: () => scroller.querySelector('iframe') };
}

/** Every height the box takes, from now on. */
function watchHeights(box: HTMLElement, heights: number[]) {
  const observer = new ResizeObserver(() => heights.push(box.offsetHeight));
  observer.observe(box);
  cleanups.push(() => observer.disconnect());
}

it('keeps the words around the page, unmounts the frame far off screen and remounts it at the same height', async () => {
  const view = list(`Before the chart.\n\n\`\`\`html-render\n${PAGE}\n\`\`\`\n\nAfter the chart.`);
  await until('the page is drawn and reports its height', () => view.box()?.offsetHeight === PAGE_HEIGHT && view.frame() !== null);
  expect(view.bubble.textContent).toContain('Before the chart.');
  expect(view.bubble.textContent).toContain('After the chart.');
  const paragraphs = [...view.bubble.querySelectorAll('p')].map(p => p.textContent);
  expect(paragraphs).toEqual(['Before the chart.', 'After the chart.']);
  expect(view.frame()!.getAttribute('sandbox')).toBe('allow-scripts');

  watchHeights(view.box()!, view.heights);
  view.scroller.scrollTop = 4000;
  await until('the frame unmounts once scrolled away', () => view.frame() === null);
  expect(view.box()!.offsetHeight).toBe(PAGE_HEIGHT);

  view.scroller.scrollTop = 0;
  await until('the frame mounts again on the way back', () => view.frame() !== null);
  // Mounted at the height it last reported, before the page has run again.
  expect(view.frame()!.getAttribute('height')).toBe(String(PAGE_HEIGHT));
  await new Promise(resolve => setTimeout(resolve, 500));
  expect(view.box()!.offsetHeight).toBe(PAGE_HEIGHT);
  expect(view.heights.every(height => height === PAGE_HEIGHT), `box heights ${view.heights.join(',')}`).toBe(true);
});

it('opens a fence at its declared height before the page runs', async () => {
  const declared = 420;
  const view = list(`\`\`\`html-render height=${declared}\n<div style="height:404px">tall</div>\n\`\`\``);
  await until('the box is drawn', () => view.box() !== null);
  expect(view.box()!.offsetHeight).toBe(declared);
  watchHeights(view.box()!, view.heights);
  await until('the page is drawn', () => view.frame() !== null);
  await new Promise(resolve => setTimeout(resolve, 500));
  expect(view.box()!.offsetHeight).toBe(declared);
  expect(view.heights.every(height => height === declared), `box heights ${view.heights.join(',')}`).toBe(true);
});
