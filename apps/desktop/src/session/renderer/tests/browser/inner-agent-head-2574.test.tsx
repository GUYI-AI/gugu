import { afterEach, beforeEach, expect, it } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { createReactHarness } from '../../../../../../../tests/support/testHarness';
import { until } from '../../../../../../../tests/support/awaitCondition';
import { InnerHeadRowLayout } from '@renderer/features/sidebar/inner-sidebar-parts';
import { SessionLocalizationProvider } from '@renderer/localization/localization-provider';
import '@/styles/tokens.css';
import '@/components/sessionpage/EmdashSessionFrame.css';
import '@renderer/index.css';

/**
 * GUYI-AI/gugu#2574 a standalone agent's inner column: its head row has no button at all (no new-agent pen, and since owner
 * 11-26 no fold button either: the column's toggle is at the content's top left). The name runs to the row's end and keeps
 * its room when the pointer is on the row: no head row has a control that only appears on hover. Real Chromium, real CSS:
 * `:hover` is the engine's own state.
 */

const LONG_NAME = '整理周报、核对日程并且顺手把下周的出差行程也排好的那个智能体';

let harness: ReturnType<typeof createReactHarness>;
beforeEach(async () => {
  await page.viewport(900, 600);
  document.documentElement.dataset.platform = 'mac';
  document.documentElement.dataset.theme = 'light';
});
afterEach(() => {
  harness?.cleanup();
  delete document.documentElement.dataset.platform;
  delete document.documentElement.dataset.theme;
});

const avatar = <span className="block size-6 rounded-full bg-[var(--border)]" />;

it('the agent head row has no buttons: the name runs to the row\'s end and keeps its room on hover', async () => {
  harness = createReactHarness();
  await harness.render(
    <div className="gugu-skin emlight" style={{ position: 'fixed', inset: 0 }}>
      <SessionLocalizationProvider>
        <div style={{ width: 260 }}>
          <InnerHeadRowLayout headKey="agent" name={LONG_NAME} avatar={avatar} active onOpen={() => {}} />
        </div>
      </SessionLocalizationProvider>
    </div>
  );
  const head = harness.container.querySelector<HTMLElement>('[data-inner-head="agent"]')!;
  const name = head.querySelector<HTMLElement>('[data-slot="button"] .truncate')!;
  const row = head.getBoundingClientRect();
  expect(row.width, 'real CSS geometry must be present: the list body insets the row').toBeGreaterThan(200);
  expect(row.width).toBeLessThan(260);
  expect(head.querySelector('button:not([data-slot="button"])'), 'no button besides the head itself').toBeNull();
  expect(head.querySelector('[data-inner-head-fold], [data-inner-head-new-agent]')).toBeNull();
  expect(name.scrollWidth, 'the name is long enough to be cut').toBeGreaterThan(name.getBoundingClientRect().width);
  expect(row.right - name.getBoundingClientRect().right, 'the name runs to the row\'s end padding').toBeLessThan(16);
  const atRest = name.getBoundingClientRect().width;
  await userEvent.hover(name);
  await until('the pointer is on the head', () => head.matches(':hover'));
  expect(name.getBoundingClientRect().width).toBeCloseTo(atRest, 0);
});
