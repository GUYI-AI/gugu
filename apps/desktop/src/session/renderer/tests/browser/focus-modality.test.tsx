import { afterEach, beforeEach, expect, it } from 'vitest';
import { userEvent } from 'vitest/browser';
import hostCss from '@/styles/tokens.css?inline';
import sessionCss from '@renderer/index.css?inline';
import '@/lib/focus-modality';
import { restyledElements } from '../../../../../../../tests/support/styleRecalc';

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
    expect(buttons[0]!.hasAttribute('data-pointer-focus'), key).toBe(false);
  }
  await userEvent.click(buttons[0]!);
  await userEvent.keyboard('{Control>}c{/Control}');
  expect(buttons[0]!.hasAttribute('data-pointer-focus')).toBe(true);
  expect(ring(buttons[0]!)).toBe('none');
});

it('the mark follows focus and never sits on an ancestor', async () => {
  await userEvent.click(buttons[0]!);
  buttons[1]!.focus();
  expect(buttons[0]!.hasAttribute('data-pointer-focus')).toBe(false);
  expect(buttons[1]!.hasAttribute('data-pointer-focus')).toBe(true);
  expect(ring(buttons[1]!)).toBe('none');
  expect(document.querySelectorAll('[data-pointer-focus]')).toHaveLength(1);
});

// @@@mark-on-the-focused-element — the mark used to sit on <html> (`:focus-visible:not([data-pointer-focus] *)`), and
// every switch between mouse and keyboard re-styled the whole document: 12.7k elements on an 8.8k-node page, growing
// with the page. Counted in elements re-styled, with 2000 bystanders on the page.
it('a switch between mouse and keyboard re-styles the focused element, not the page', async () => {
  const bystanders = document.createElement('div');
  bystanders.innerHTML = '<p><span><b>bystander</b></span></p>'.repeat(500);
  document.body.appendChild(bystanders);
  owned.push(bystanders);
  expect(bystanders.querySelectorAll('*')).toHaveLength(1500);

  // positive control for the ruler: an inherited property on the root does reach every bystander
  const all = await restyledElements(() => { document.documentElement.style.setProperty('--ruler-control', '1'); });
  document.documentElement.style.removeProperty('--ruler-control');
  expect(all).toBeGreaterThanOrEqual(1500);

  await userEvent.click(buttons[0]!);
  const toKeyboard = await restyledElements(() => userEvent.keyboard('{ArrowDown}'));
  expect(ring(buttons[0]!)).toBe('solid');
  const toPointer = await restyledElements(() => userEvent.click(buttons[1]!));
  expect(ring(buttons[1]!)).toBe('none');
  expect(toKeyboard).toBeLessThan(50);
  expect(toPointer).toBeLessThan(50);
});
