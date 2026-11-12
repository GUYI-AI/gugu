import { afterEach, beforeEach, expect, it } from 'vitest';
import { userEvent } from 'vitest/browser';
import hostCss from '@/styles/tokens.css?inline';
import sessionCss from '@renderer/index.css?inline';
import '@/lib/focus-modality';

// @@@focus-modality — real Chromium input: a mouse click leaves no ring, a bare modifier key afterwards (a screenshot hotkey)
// leaves none either, keyboard navigation draws it. Both the global rule and the Tailwind `focus-visible:` variant.
const owned: HTMLElement[] = [];
let buttons: HTMLButtonElement[] = [];
beforeEach(() => {
  for (const css of [hostCss, sessionCss]) {
    const sheet = document.createElement('style');
    sheet.textContent = css;
    document.head.appendChild(sheet);
    owned.push(sheet);
  }
  const host = document.createElement('section');
  // `focus-visible:opacity-100` is used in the app; the Tailwind variant must follow the same modality.
  host.innerHTML = '<button id="a">First</button><button id="b" class="opacity-50 focus-visible:opacity-100">Second</button>';
  document.body.appendChild(host);
  owned.push(host);
  buttons = [...host.querySelectorAll('button')];
});
afterEach(() => {
  owned.splice(0).forEach((node) => node.remove());
  document.documentElement.removeAttribute('data-pointer-focus');
});

const ring = (el: Element) => getComputedStyle(el).outlineStyle;
const opacity = (el: Element) => getComputedStyle(el).opacity;

it('a mouse click draws no ring', async () => {
  await userEvent.click(buttons[0]!);
  expect(document.activeElement).toBe(buttons[0]);
  expect(ring(buttons[0]!)).toBe('none');
});

it('a bare Shift after a click still draws no ring, though Chromium now reports :focus-visible', async () => {
  await userEvent.click(buttons[1]!);
  await userEvent.keyboard('{Shift}');
  // positive control: this is the state that drew the ring before
  expect(buttons[1]!.matches(':focus-visible')).toBe(true);
  expect(ring(buttons[1]!)).toBe('none');
  expect(opacity(buttons[1]!)).toBe('0.5');
});

it('Tab draws the ring and the focus-visible variant', async () => {
  await userEvent.click(buttons[0]!);
  await userEvent.keyboard('{Tab}');
  expect(document.activeElement).toBe(buttons[1]);
  expect(ring(buttons[1]!)).toBe('solid');
  expect(opacity(buttons[1]!)).toBe('1');
});

it('Enter, Space and arrow keys count as navigation; a Ctrl / Meta shortcut does not', async () => {
  for (const key of ['{Enter}', ' ', '{ArrowDown}']) {
    await userEvent.click(buttons[0]!);
    await userEvent.keyboard(key);
    expect(document.documentElement.hasAttribute('data-pointer-focus'), key).toBe(false);
  }
  await userEvent.click(buttons[0]!);
  await userEvent.keyboard('{Control>}c{/Control}');
  expect(document.documentElement.hasAttribute('data-pointer-focus')).toBe(true);
  expect(ring(buttons[0]!)).toBe('none');
});
