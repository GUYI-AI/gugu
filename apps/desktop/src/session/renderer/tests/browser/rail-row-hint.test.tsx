import { useRef } from 'react';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { createReactHarness } from '../../../../../../../tests/support/testHarness';
import { until } from '../../../../../../../tests/support/awaitCondition';
import { ListRow } from '@/components/ui/ListRow';
import { RailRowHint } from '@renderer/features/sidebar/rail-row-hint';
import '@/styles/tokens.css';

/**
 * The collapsed sidebar is a rail of avatars: pointing at one says the row's own name and second line in the product's
 * tooltip (never the browser's `title`). Real Chromium: the pointer and the popup's place are the engine's own.
 */

let harness: ReturnType<typeof createReactHarness>;
beforeEach(async () => {
  await page.viewport(900, 600);
});
afterEach(() => harness?.cleanup());

function Rail({ enabled }: { enabled: boolean }) {
  const list = useRef<HTMLDivElement>(null);
  return (
    <div ref={list} style={{ position: 'fixed', left: 0, top: 0, width: 72 }}>
      <RailRowHint list={list} enabled={enabled} />
      <ListRow data-row="group" leading={<span style={{ display: 'block', width: 32, height: 32 }} />} title="Weekend hikers" subtitle="See you at eight" />
      <ListRow data-row="person" leading={<span style={{ display: 'block', width: 32, height: 32 }} />} title="Lin" />
    </div>
  );
}

const hint = () => document.querySelector<HTMLElement>('[data-rail-row-hint]');
const row = (name: string) => harness.container.querySelector<HTMLElement>(`[data-row="${name}"]`)!;

it('pointing at a row on the rail shows its name and second line beside it; the next row changes it; no native title', async () => {
  harness = createReactHarness();
  await harness.render(<Rail enabled />);
  expect(hint()).toBeNull();
  expect(harness.container.querySelector('[title]')).toBeNull();

  await userEvent.hover(row('group'));
  await until('the hint comes up', hint, (popup) => popup?.textContent === 'Weekend hikersSee you at eight');
  const popup = hint()!.getBoundingClientRect();
  const target = row('group').getBoundingClientRect();
  expect(popup.left, 'beside the row, not over it').toBeGreaterThanOrEqual(target.right);
  expect(popup.top).toBeLessThan(target.bottom);
  expect(popup.bottom).toBeGreaterThan(target.top);

  await userEvent.hover(row('person'));
  await until('the hint follows the pointer to the next row', hint, (next) => next?.textContent === 'Lin');

  await userEvent.unhover(row('person'));
  await until('the hint leaves with the pointer', hint, (gone) => gone === null);
});

it('the list opening puts the hint away: open, the rows say their own names', async () => {
  harness = createReactHarness();
  await harness.render(<Rail enabled />);
  await userEvent.hover(row('group'));
  await until('the hint comes up on the rail', hint, (popup) => popup !== null);
  await harness.render(<Rail enabled={false} />);
  await until('the hint is gone once the list is open', hint, (popup) => popup === null);
});
