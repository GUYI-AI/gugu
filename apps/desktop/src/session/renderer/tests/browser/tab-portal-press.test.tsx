/**
 * A tab's right-click menu is portalled out of the tab, but React bubbles its presses through the tab. The left click that
 * closes the menu must not arm the tab's drag: its pointerup can land in another document (an App's page under the vanished
 * backdrop), and the armed drag then starts on the next move and floats with the pointer (the topic inner strip, owner 11-20).
 */
import { DndContext, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import { createPortal } from 'react-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { act } from 'react';
import { cdp } from 'vitest/browser';
import { createReactHarness } from '../../../../../../../tests/support/testHarness';
import { DraggableTab } from '@renderer/features/tabs/tab-bar/draggable-tab';
import '@/styles/tokens.css';
import '@renderer/index.css';

let harness: ReturnType<typeof createReactHarness>;
afterEach(() => harness?.cleanup());

function Fixture({ onDragStart }: { onDragStart: () => void }) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  return (
    <DndContext sensors={sensors} onDragStart={onDragStart}>
      <div style={{ display: 'flex', width: 400, height: 36 }}>
        <DraggableTab id="tab-a">
          <div data-testid="tab-chip" style={{ width: 160, height: 36 }}>App</div>
          {createPortal(<div data-testid="menu-backdrop" style={{ position: 'fixed', left: 0, top: 200, width: 400, height: 200 }} />, document.body)}
        </DraggableTab>
      </div>
    </DndContext>
  );
}

// Trusted mouse input through CDP, mapped into the test iframe (same as tab-order-motion.test.tsx).
async function pointer(type: 'mouseMoved' | 'mousePressed' | 'mouseReleased', x: number, y: number, down: boolean) {
  const frame = (window.frameElement as HTMLElement | null)?.getBoundingClientRect() ?? { left: 0, top: 0, width: innerWidth, height: innerHeight };
  await act(async () => { await cdp().send('Input.dispatchMouseEvent', { type, x: frame.left + x * frame.width / innerWidth, y: frame.top + y * frame.height / innerHeight, button: type === 'mouseMoved' && !down ? 'none' : 'left', buttons: down ? 1 : 0, clickCount: type === 'mouseMoved' ? 0 : 1 }); });
}

async function pressAndMove(testId: string) {
  const box = document.querySelector(`[data-testid="${testId}"]`)!.getBoundingClientRect();
  const x = box.left + 20, y = box.top + 10;
  await pointer('mouseMoved', x, y, false);
  await pointer('mousePressed', x, y, true);
  for (let i = 1; i <= 5; i++) await pointer('mouseMoved', x + i * 8, y, true);
  await pointer('mouseReleased', x + 40, y, false);
}

it('a press on the tab’s portalled menu never starts the tab’s drag; a press on the tab still does', async () => {
  const onDragStart = vi.fn();
  harness = createReactHarness();
  await harness.render(<Fixture onDragStart={onDragStart} />);
  await pressAndMove('menu-backdrop');
  expect(onDragStart, 'pressed on the portalled backdrop').not.toHaveBeenCalled();
  await pressAndMove('tab-chip');
  expect(onDragStart, 'pressed on the tab itself').toHaveBeenCalledTimes(1);
});
