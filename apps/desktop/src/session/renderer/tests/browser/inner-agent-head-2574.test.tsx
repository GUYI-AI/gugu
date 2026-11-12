import { afterEach, beforeEach, expect, it } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { createReactHarness } from '../../../../../../../tests/support/testHarness';
import { until } from '../../../../../../../tests/support/awaitCondition';
import { InnerHeadActionsMenu, InnerHeadRowLayout, InnerSidebarFoldButton } from '@renderer/features/sidebar/inner-sidebar-parts';
import { SessionLocalizationProvider } from '@renderer/localization/localization-provider';
import '@/styles/tokens.css';
import '@/components/sessionpage/EmdashSessionFrame.css';
import '@renderer/index.css';

/**
 * GUYI-AI/gugu#2574 a standalone agent's inner column: its head row has only the fold button (no new-agent pen, no 「…」).
 * The name runs up to that button and keeps its room when the pointer is on the row: there is no 「…」 to open a slot for,
 * unlike a head that has one (a group, a project, the sample). Real Chromium, real CSS: `:hover` is the engine's own state.
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

it("the agent head row ends in the fold button and keeps the name's room on hover; a head with 「…」 opens a slot for it", async () => {
  harness = createReactHarness();
  await harness.render(
    <div className="gugu-skin emlight" style={{ position: 'fixed', inset: 0 }}>
      <SessionLocalizationProvider>
        <div style={{ width: 260 }}>
          <InnerHeadRowLayout headKey="agent" name={LONG_NAME} avatar={avatar} active onOpen={() => {}} trailingButtons={1} hoverMenu={false}>
            <InnerSidebarFoldButton />
          </InnerHeadRowLayout>
          <InnerHeadRowLayout headKey="room" name={LONG_NAME} avatar={avatar} active={false} onOpen={() => {}} trailingButtons={1}>
            <InnerHeadActionsMenu label="actions">
              <span />
            </InnerHeadActionsMenu>
            <InnerSidebarFoldButton />
          </InnerHeadRowLayout>
        </div>
      </SessionLocalizationProvider>
    </div>
  );
  const head = (key: string) => harness.container.querySelector<HTMLElement>(`[data-inner-head="${key}"]`)!;
  const name = (key: string) => head(key).querySelector<HTMLElement>('[data-slot="button"] .truncate')!;
  const nameWidth = (key: string) => name(key).getBoundingClientRect().width;

  const row = head('agent').getBoundingClientRect();
  const fold = head('agent').querySelector<HTMLElement>('[data-inner-head-fold]')!.getBoundingClientRect();
  expect(row.width, 'real CSS geometry must be present: the list body insets the row').toBeGreaterThan(200);
  expect(row.width).toBeLessThan(260);
  expect(head('agent').querySelector('[data-inner-head-actions]')).toBeNull();
  expect(head('agent').querySelector('[data-inner-head-new-agent]')).toBeNull();
  // The fold button sits at the row's far end; the (truncated) name stops before it.
  expect(row.right - fold.right).toBeCloseTo(8, 0);
  expect(name('agent').scrollWidth, 'the name is long enough to be cut').toBeGreaterThan(nameWidth('agent'));
  expect(name('agent').getBoundingClientRect().right).toBeLessThanOrEqual(fold.left);
  const agentAtRest = nameWidth('agent');
  expect(nameWidth('room'), 'at rest both names have the same room (「…」 takes none)').toBeCloseTo(agentAtRest, 0);

  // A head with 「…」: the pointer on it opens the slot, the name gives up its width.
  await userEvent.hover(name('room'));
  await until('the room head gives 「…」 its slot on hover', () => nameWidth('room'), (width) => width < agentAtRest - 30);

  // The agent head: the pointer on it changes nothing.
  await userEvent.hover(name('agent'));
  await until('the pointer is on the agent head', () => head('agent').matches(':hover'));
  expect(nameWidth('agent')).toBeCloseTo(agentAtRest, 0);
  expect(name('agent').getBoundingClientRect().right).toBeLessThanOrEqual(fold.left);
});
