import { afterEach, beforeEach, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import { createReactHarness } from '../../../../../../../tests/support/testHarness';
import { ListColumnToggle } from '@/components/PanelToggleButtons';
import { PanelToggleIcon } from '@/components/PanelToggleIcon';
import { publishPanelToggle } from '@/lib/panelToggles';
import '@/styles/tokens.css';
import '@renderer/index.css';

/**
 * @@@panel-toggle-icon — every panel toggle says open / folded with its arrow (owner 11-26: lucide panel-left-close ⇄
 * panel-left-open), not with a highlight. The arrow is mirrored about its own x=15, so folded is exactly lucide's open glyph.
 */

let harness: ReturnType<typeof createReactHarness>;
let unpublish: () => void = () => {};
beforeEach(async () => {
  await page.viewport(600, 300);
  document.documentElement.dataset.theme = 'light';
});
afterEach(() => {
  harness?.cleanup();
  unpublish();
  delete document.documentElement.dataset.theme;
});

/** The arrow's horizontal extent in the glyph's 24-unit box, as drawn. */
function arrowSpan(svg: SVGSVGElement): [number, number] {
  const box = svg.getBoundingClientRect();
  const arrow = svg.querySelector('[data-panel-toggle-arrow]')!.getBoundingClientRect();
  const unit = box.width / 24;
  return [Math.round(((arrow.left - box.left) / unit) * 10) / 10, Math.round(((arrow.right - box.left) / unit) * 10) / 10];
}

it('open points the way the column folds, folded is lucide\'s open glyph; both rest without a highlight', async () => {
  let open = true;
  const render = () => {
    unpublish();
    unpublish = publishPanelToggle('column:inner', { open, label: open ? '收起' : '展开', toggle: () => {} });
  };
  render();
  harness = createReactHarness();
  await harness.render(<div className="gugu-skin" style={{ padding: 40 }}><ListColumnToggle slot="column:inner" /></div>);
  const button = harness.container.querySelector<HTMLButtonElement>('[data-titlebar-sidebar-toggle]')!;
  const svg = () => button.querySelector<SVGSVGElement>('svg[data-panel-toggle-icon]')!;
  const settle = () => new Promise((done) => setTimeout(done, 400));
  await settle();
  expect(button.getAttribute('aria-expanded')).toBe('true');
  // lucide PanelLeftClose: m16 15-3-3 3-3 → x 13..16 (the path box, without the stroke).
  expect(arrowSpan(svg())).toEqual([13, 16]);
  const openBackground = getComputedStyle(button).backgroundColor;

  open = false;
  render();
  await settle();
  expect(button.getAttribute('aria-expanded')).toBe('false');
  // lucide PanelLeftOpen: m14 9 3 3-3 3 → x 14..17.
  expect(arrowSpan(svg())).toEqual([14, 17]);
  expect(getComputedStyle(button).backgroundColor, 'open and folded rest the same; the arrow carries the state').toBe(openBackground);
  expect(getComputedStyle(svg().querySelector('[data-panel-toggle-arrow]')!).transitionProperty).toContain('transform');
});

it('the right-hand toggle is the mirror image: lucide PanelRightClose / PanelRightOpen', async () => {
  harness = createReactHarness();
  await harness.render(
    <div style={{ display: 'flex', gap: 8, padding: 40 }}>
      <PanelToggleIcon side="right" open />
      <PanelToggleIcon side="right" open={false} />
    </div>
  );
  await new Promise((done) => setTimeout(done, 400));
  const [opened, folded] = [...harness.container.querySelectorAll<SVGSVGElement>('svg[data-panel-toggle-icon="right"]')];
  // PanelRightClose: m8 9 3 3-3 3 → x 8..11; PanelRightOpen: m10 15-3-3 3-3 → x 7..10 (path boxes, without the stroke).
  expect(arrowSpan(opened)).toEqual([8, 11]);
  expect(arrowSpan(folded)).toEqual([7, 10]);
  // The divider sits on the right: x=15.
  const divider = opened.querySelector('path:not([data-panel-toggle-arrow])')!.getBoundingClientRect();
  const box = opened.getBoundingClientRect();
  expect(Math.round(((divider.left + divider.right) / 2 - box.left) / (box.width / 24))).toBe(15);
});
