/**
 * @@@pane-size-read — a pane's size reaches its sink from its ResizeObserver, as the observer gives it: a fold or a divider
 * drag resizes the pane in every frame, right after other observers have written styles, so reading the box again there is
 * a forced layout in every frame.
 */
import { afterEach, expect, it, vi } from 'vitest';
import { createReactHarness } from '../../../../../../../tests/support/testHarness';
import { createPaneDimensionSink, PaneDimensionProvider } from '@renderer/features/tabs/pane-dimension-provider';
import '@renderer/index.css';

let harness: ReturnType<typeof createReactHarness>;
afterEach(() => { vi.restoreAllMocks(); harness?.cleanup(); });
const frame = () => new Promise(requestAnimationFrame);

it('a pane resized frame by frame takes each size from its observer and reads no layout for it', async () => {
  harness = createReactHarness();
  const sink = createPaneDimensionSink();
  await harness.render(<div data-box="" style={{ width: 400, height: 300 }}><PaneDimensionProvider sink={sink}><p>a pane</p></PaneDimensionProvider></div>);
  for (let settled = 0; settled < 4; settled++) await frame();
  const box = harness.container.querySelector<HTMLElement>('[data-box]')!, pane = box.firstElementChild!;
  const read = vi.spyOn(Element.prototype, 'getBoundingClientRect');
  for (const width of [380, 360, 340]) {
    box.style.width = `${width}px`;
    await frame();
    await frame();
    expect(sink.dimensions).toEqual({ width, height: 300 });
  }
  expect(read.mock.contexts.filter((element) => element === pane)).toHaveLength(0);
});
