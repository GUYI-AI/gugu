/**
 * A press inside an embedded guest page (an App's or a file's page) closes an open menu, like a press anywhere else
 * outside it. The guest's document takes that press: the host only sees its window blur with the guest's element focused,
 * which @@@guest-press replays as a press on that element. A real CDP mouse press, so focus really moves into the frame.
 */
import { afterEach, expect, it } from 'vitest';
import { cdp, page } from 'vitest/browser';
import { act, useState } from 'react';
import { createReactHarness } from '../../../../../../../tests/support/testHarness';
import { until } from '../../../../../../../tests/support/awaitCondition';
import { DropdownMenu, MenuItem } from '@/components/ui/Menu';
import '@/lib/guest-press';
import '@/styles/tokens.css';
import '@renderer/index.css';

let harness: ReturnType<typeof createReactHarness>;
afterEach(() => { harness?.cleanup(); });

type Session = { send: (method: string, params: object) => Promise<unknown> };
/** CDP takes top-page coordinates; map through every test frame's offset and scale. */
function toPage(x: number, y: number) {
  for (let current: Window = window; current.frameElement; current = current.parent) {
    const frame = current.frameElement as HTMLElement, box = frame.getBoundingClientRect();
    const scale = box.width / frame.offsetWidth;
    x = box.left + (frame.clientLeft + x) * scale;
    y = box.top + (frame.clientTop + y) * scale;
  }
  return { x, y };
}
async function press(element: Element) {
  const rect = element.getBoundingClientRect();
  const at = toPage(rect.left + rect.width / 2, rect.top + rect.height / 2);
  const send = (type: string, buttons: number) => act(async () => {
    await (cdp() as unknown as Session).send('Input.dispatchMouseEvent', { type, ...at, button: 'left', buttons, clickCount: 1 });
  });
  await send('mousePressed', 1);
  await send('mouseReleased', 0);
}

function Header() {
  const [open, setOpen] = useState(false);
  return <div style={{ display: 'flex', gap: 24, padding: 24 }}>
    <DropdownMenu.Root open={open} modal={false} onOpenChange={setOpen}>
      <DropdownMenu.Trigger data-testid="more">More</DropdownMenu.Trigger>
      {open && <DropdownMenu.Content data-testid="more-menu"><MenuItem onClick={() => {}}>Search</MenuItem></DropdownMenu.Content>}
    </DropdownMenu.Root>
    <iframe title="guest" srcDoc="<p style='height:200px'>an App page</p>" style={{ width: 400, height: 240, marginTop: 120 }} />
  </div>;
}

it('a press inside a guest frame closes the open menu', async () => {
  await page.viewport(900, 500);
  harness = createReactHarness();
  await harness.render(<Header />);
  const menu = () => document.querySelector('[data-testid="more-menu"]');
  const frame = harness.container.querySelector('iframe')!;
  await until('the guest page has loaded', () => frame.contentDocument?.body?.textContent?.includes('an App page') ?? false);

  await press(harness.container.querySelector('[data-testid="more"]')!);
  await until('the menu opens', () => menu() !== null);

  await press(frame);
  await until('the menu closes after a press inside the guest', () => menu() === null);
  expect(document.activeElement, 'the press really went into the guest').toBe(frame);
});
