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
          file unavailable onClick={event => event.preventDefault()}>{label}</MentionPill></p></div>
      </div>)}
    </div>,
  ));
  const bubbles = [...host.querySelectorAll<HTMLElement>('[data-bubble]')];
  for (const bubble of bubbles) {
    const pill = bubble.querySelector<HTMLElement>('.gg-file-pill')!;
    const label = pill.querySelector<HTMLElement>('.gg-file-pill-label')!;
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
  const longLabel = bubbles[0].querySelector<HTMLElement>('.gg-file-pill-label')!;
  expect(longLabel.scrollWidth).toBeGreaterThan(longLabel.clientWidth);
  const shortLabel = bubbles[1].querySelector<HTMLElement>('.gg-file-pill-label')!;
  expect(shortLabel.scrollWidth).toBe(shortLabel.clientWidth);
  expect(bubbles[1].getBoundingClientRect().width).toBeLessThan(120);
});
