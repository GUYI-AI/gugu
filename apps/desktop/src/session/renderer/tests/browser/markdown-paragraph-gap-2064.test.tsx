/**
 * #2064 moved the markdown sibling rules off bare tags (`li + li`, `li > p + p`) so a portal leaving <body> stops
 * restyling the whole page. The spacing they drew must stay what it was: an item gets the list gap only after
 * another item, and a paragraph in an item gets the block gap only after another paragraph. Any other block before
 * a paragraph (nested list, quote, code, table, rule, heading) keeps its own bottom margin as the gap.
 *
 * Reads the layout of what Streamdown actually renders, in both densities.
 */
import { createRoot, type Root } from 'react-dom/client';
import { Streamdown } from 'streamdown';
import { afterEach, expect, it } from 'vitest';
import '@gugu/session-ui/styles/global';
import '@gugu/session-ui/theme/theme.css';
import '@gugu/session-ui/theme/semantic.css';
import '@gugu/session-ui/styles/base.css';
import '@/styles/tokens.css';
import '@renderer/index.css';
import '@gugu/session-shared/markdown.css';
import { until } from '../../../../../../../tests/support/awaitCondition';

const PARAGRAPH_GAP_FIXTURE = [
  'First paragraph.',
  '',
  'Second paragraph.',
  '',
  '- tight one',
  '- tight two',
  '  - nested tight',
  '  - nested tight two',
  '- tight three',
  '',
  'Between lists.',
  '',
  '1. loose item paragraph',
  '',
  '   second paragraph in the item',
  '',
  '   - nested list inside a loose item',
  '   - nested two',
  '',
  '   paragraph after the nested list',
  '',
  '   > quote inside the item',
  '',
  '   paragraph after the quote',
  '',
  '   ```ts',
  '   const inItem = 1;',
  '   ```',
  '',
  '   paragraph after the code block',
  '',
  '   | A | B |',
  '   | - | - |',
  '   | 1 | 2 |',
  '',
  '   paragraph after the table',
  '',
  '   ---',
  '',
  '   paragraph after the rule',
  '',
  '2. ### heading first in an item',
  '',
  '   paragraph after the heading',
  '',
  '   another paragraph',
  '',
  '- [ ] loose task',
  '',
  '  task detail',
  '',
  '- [x] done task',
  '',
  '> quote paragraph one',
  '>',
  '> quote paragraph two',
  '>',
  '> - list in quote',
  '> - list in quote two',
  '>',
  '> quote paragraph after list',
  '',
  '## Heading',
  '',
  'Closing paragraph.',
].join('\n');

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  root?.unmount();
  host?.remove();
  root = null;
  host = null;
});

it.each(['gg-md--compact', 'gg-md--comfortable'])('%s spaces items and item paragraphs only after their own kind', async (density) => {
  host = document.createElement('div');
  host.style.cssText = 'width: 520px; font-size: 14px;';
  document.body.appendChild(host);
  root = createRoot(host);
  root.render(
    <div className={`gg-md ${density}`}>
      <Streamdown>{PARAGRAPH_GAP_FIXTURE}</Streamdown>
    </div>,
  );
  await until('the fixture rendered its table and code block', () =>
    host!.querySelector('li table') !== null && host!.querySelector('li [data-streamdown="code-block"]') !== null,
  );
  const body = host.querySelector<HTMLElement>('.gg-md')!;
  const length = (name: string) => {
    const probe = document.createElement('div');
    probe.style.marginTop = `var(${name})`;
    body.appendChild(probe);
    const value = getComputedStyle(probe).marginTop;
    probe.remove();
    return value;
  };
  const gap = length('--md-gap');
  const liGap = length('--md-li-gap');
  expect(Number.parseFloat(gap)).toBeGreaterThan(Number.parseFloat(liGap));

  const items = [...body.querySelectorAll('li')];
  const paragraphs = [...body.querySelectorAll<HTMLElement>('li > p')];
  // Every structure the fixture promises is there, so the reads below are not vacuous.
  for (const before of ['UL', 'BLOCKQUOTE', 'DIV', 'HR', 'H3', 'P']) {
    expect(paragraphs.some(p => p.previousElementSibling?.tagName === before), before).toBe(true);
  }
  const label = (el: Element) => el.textContent!.slice(0, 32);
  expect(items.map(li => [label(li), getComputedStyle(li).marginTop]))
    .toEqual(items.map(li => [label(li), li.previousElementSibling?.tagName === 'LI' ? liGap : '0px']));
  // The drawn gap above each item paragraph: the block gap after a paragraph, otherwise the block before keeps its own
  // bottom margin. Read from layout, since the margins collapse.
  const drawn = (p: Element) => Math.round((p.getBoundingClientRect().top - p.previousElementSibling!.getBoundingClientRect().bottom) * 10) / 10;
  const expected = (p: Element) => Math.round(Number.parseFloat(p.previousElementSibling!.tagName === 'P' ? gap : getComputedStyle(p.previousElementSibling!).marginBottom) * 10) / 10;
  const following = paragraphs.filter(p => p.previousElementSibling);
  expect(following.map(p => [label(p), drawn(p)])).toEqual(following.map(p => [label(p), expected(p)]));
});
