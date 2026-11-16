import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import { MentionPill } from '@/components/markdown/MentionPill';
import { buildBubbleStyle } from '@/components/chat/messageBubbleStyle';
import '@gugu/session-shared/markdown.css';
import '@/styles/tokens.css';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement | undefined;
let root: Root | undefined;
const previousTheme = document.documentElement.getAttribute('data-theme');
afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  if (previousTheme === null) document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', previousTheme);
});

it.each([
  { width: 390, theme: 'dark' }, { width: 390, theme: 'light' },
  { width: 1280, theme: 'dark' }, { width: 1280, theme: 'light' },
])('keeps the complete file pill inside the bubble at $width in $theme', async ({ width, theme }) => {
  await page.viewport(width, 844);
  document.documentElement.setAttribute('data-theme', theme);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  const long = `查看《${'电商AI落地与RPA自动化实施方案'.repeat(12)}》`;
  await act(async () => root!.render(
    <div className="gugu-skin" style={{ width: width === 390 ? 294 : 420, containerType: 'inline-size' }}>
      {[long, '方案'].map(label => <div key={label} data-bubble style={buildBubbleStyle(false, false, width === 390)}>
        <div className="gg-md"><p><MentionPill href="gugu-file://aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" title={label}
          file={label} unavailable onClick={event => event.preventDefault()}>{label}</MentionPill></p></div>
      </div>)}
    </div>,
  ));
  const bubbles = [...host.querySelectorAll<HTMLElement>('[data-bubble]')];
  for (const bubble of bubbles) {
    const pill = bubble.querySelector<HTMLElement>('.gg-file-pill')!;
    const label = pill.querySelector<HTMLElement>('.gg-md-mention-label')!;
    const icon = pill.querySelector<HTMLElement>('.gg-md-mention-icon')!;
    const bounds = bubble.getBoundingClientRect();
    const style = getComputedStyle(bubble);
    const contentRight = bounds.right - parseFloat(style.paddingRight);
    const pillBounds = pill.getBoundingClientRect();
    expect(pillBounds.width).toBeGreaterThan(0);
    expect(pillBounds.right).toBeLessThanOrEqual(contentRight + 0.5);
    expect(pillBounds.left).toBeGreaterThanOrEqual(bounds.left + parseFloat(style.paddingLeft) - 0.5);
    expect(label.getBoundingClientRect().right).toBeLessThanOrEqual(pillBounds.right);
    expect(icon.getBoundingClientRect().width).toBeGreaterThan(10);
    expect(getComputedStyle(label).textOverflow).toBe('ellipsis');
  }
  const longLabel = bubbles[0].querySelector<HTMLElement>('.gg-md-mention-label')!;
  expect(longLabel.scrollWidth).toBeGreaterThan(longLabel.clientWidth);
  const shortLabel = bubbles[1].querySelector<HTMLElement>('.gg-md-mention-label')!;
  expect(shortLabel.scrollWidth).toBe(shortLabel.clientWidth);
  expect(bubbles[1].getBoundingClientRect().width).toBeLessThan(120);
});

/** The place's left edge less the name's visible end (the characters that fit before the ellipsis, then the ellipsis). */
function gapBeforePlace(name: HTMLElement, place: HTMLElement): number {
  const text = name.firstChild as Text;
  const ellipsis = name.appendChild(document.createElement('span'));
  ellipsis.textContent = '\u2026';
  const ellipsisWidth = ellipsis.getBoundingClientRect().width;
  ellipsis.remove();
  const limit = name.getBoundingClientRect().right - ellipsisWidth;
  const range = document.createRange();
  let end = name.getBoundingClientRect().left;
  for (let i = 0; i < text.length; i += 1) {
    range.setStart(text, i);
    range.setEnd(text, i + 1);
    if (range.getBoundingClientRect().right > limit + 0.5) break;
    end = range.getBoundingClientRect().right;
  }
  return place.getBoundingClientRect().left - (end + ellipsisWidth);
}

it.each(['dark', 'light'])('keeps a long cited name\'s place whole, right after its ellipsis, in %s', async (theme) => {
  await page.viewport(390, 844);
  document.documentElement.setAttribute('data-theme', theme);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  const label = `${'电商AI落地与RPA自动化实施方案'.repeat(6)}.md (Lines 3–4)`;
  await act(async () => root!.render(
    <div className="gugu-skin" style={{ width: 294, containerType: 'inline-size' }}>
      <div data-bubble style={buildBubbleStyle(false, false, true)}>
        <div className="gg-md"><p><MentionPill href="gugu-file://aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" title={label} file={label} mention
          onClick={event => event.preventDefault()}>{label}</MentionPill></p></div>
      </div>
    </div>,
  ));
  const pill = host.querySelector<HTMLElement>('.gg-file-pill')!;
  const name = pill.querySelector<HTMLElement>('.gg-md-mention-label')!;
  const place = pill.querySelector<HTMLElement>('.gg-md-mention-place');
  expect(place?.textContent).toBe(' (Lines 3–4)');
  expect(place!.scrollWidth).toBeLessThanOrEqual(place!.clientWidth);
  expect(place!.getBoundingClientRect().right).toBeLessThanOrEqual(pill.getBoundingClientRect().right);
  expect(name.scrollWidth).toBeGreaterThan(name.clientWidth);
  expect(gapBeforePlace(name, place!)).toBeLessThanOrEqual(parseFloat(getComputedStyle(name).fontSize));
});
