import { afterEach, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import html from '../../../../../preinstalled-apps/workspace/index.html?raw';
import css from '../../../../../preinstalled-apps/workspace/style.css?raw';
import ui from '../../../app-runtime/ui/ui.css?raw';
// @ts-expect-error — the built-in App is a plain ES module with no types; the runtime import works.
import { fitTools } from '../../../../../preinstalled-apps/workspace/list.js';
import { until } from '../../../../../../../tests/support/awaitCondition';

// The folder's bar on a phone, as owner 11-14 met it: a project group (Chat / Computer switch), files (Select), the right to add
// (「+」). Phone widths run from 300 (a 390 px phone at system font size 130%: the page is that much narrower, pageScale.ts)
// to 412. Shipped DOM and stylesheets; the phone's touch rules are the coarse-pointer block, switched on here because the
// test browser has a mouse. Token values are the ones the phone host hands the App (read on an Android emulator).
let frame: HTMLIFrameElement;
afterEach(() => frame?.remove());

const WIDTHS = [300, 320, 360, 390, 412];
const LABELS = {
  en: { chat: ['Chat files', 'Chat'], computer: ['Computer files', 'Computer'], sort: 'Recent', filtered: 'Recent · Filtered', pick: 'Select' },
  zh: { chat: ['聊天文件', '聊天'], computer: ['电脑文件', '电脑'], sort: '最近', filtered: '最近 · 已筛选', pick: '选择' },
};

async function bar(width: number, locale: keyof typeof LABELS, filtered: boolean) {
  frame = document.createElement('iframe');
  frame.style.cssText = `width:${width}px;height:400px;border:0`;
  document.body.append(frame);
  const doc = frame.contentDocument!;
  doc.open(); doc.write(html.replace(/<link[^>]*>|<script[^>]*>[\s\S]*?<\/script>/g, '')); doc.close();
  const style = doc.createElement('style');
  style.textContent = `:root { --em-font-body:14px; --em-lh-body:20px; --em-font-caption:12px; --em-lh-caption:18px; --em-spacing-xs:4px; --em-spacing-sm:8px; --em-spacing-md:12px; --em-spacing-lg:16px; --em-control-h-md:44px; --em-radius-control:8px; }\n${ui}\n${css.replaceAll('@media (hover: none) and (pointer: coarse)', '@media all')}`;
  doc.head.append(style);
  const get = (id: string) => doc.getElementById(id)!;
  const t = LABELS[locale];
  const [chat, computer] = [...get('place-switch').children] as HTMLButtonElement[];
  for (const [button, [name, short]] of [[chat, t.chat], [computer, t.computer]] as const) {
    const [long, brief] = button.querySelectorAll('span');
    long.textContent = name; brief.textContent = short; button.title = name;
  }
  chat.setAttribute('aria-pressed', 'true');
  get('sort-label').textContent = filtered ? t.filtered : t.sort;
  get('select-files').textContent = t.pick;
  get('new-doc').hidden = false;
  await until('the guest has its real width', () => doc.documentElement.clientWidth === width);
  const toolbar = doc.querySelector<HTMLElement>('.files-toolbar')!;
  fitTools(toolbar, get('sort-label'));
  return { doc, toolbar, get };
}

const cases = WIDTHS.flatMap((width) => (['en', 'zh'] as const).flatMap((locale) => [false, true].map((filtered) => [width, locale, filtered] as const)));

it.each(cases)('at %spx (%s, filtered %s) every control of the bar is whole and inside the pane', async (width, locale, filtered) => {
  await page.viewport(1100, 800);
  const { doc, toolbar, get } = await bar(width, locale, filtered);
  for (const control of [...toolbar.children].filter((el) => (el as HTMLElement).offsetParent)) {
    const box = control.getBoundingClientRect();
    expect(box.left, control.id || control.className).toBeGreaterThanOrEqual(0);
    expect(box.right, control.id || control.className).toBeLessThanOrEqual(width);
  }
  expect(toolbar.scrollWidth).toBeLessThanOrEqual(toolbar.clientWidth);
  expect(doc.documentElement.scrollWidth).toBeLessThanOrEqual(width);
  const sort = get('sort-label');
  // The order's words are cut only with an ellipsis.
  if (sort.scrollWidth > sort.clientWidth) expect(getComputedStyle(sort).textOverflow).toBe('ellipsis');
  // The switch keeps its names however it is drawn (with its words hidden, the title is the name).
  for (const button of get('place-switch').children) expect((button as HTMLElement).title).toBeTruthy();
});

it('the switch keeps its words where they fit', async () => {
  await page.viewport(1100, 800);
  const { toolbar } = await bar(412, 'en', false);
  expect(toolbar.classList.contains('places-icons')).toBe(false);
});
