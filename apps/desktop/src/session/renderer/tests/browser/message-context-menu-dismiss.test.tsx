/**
 * 右键菜单开出后立刻点外面就得关(owner 11-07:右键后趁悬浮条还没消失左键点气泡,菜单不关)。
 * 根因在 ui/Menu:借 ContextMenu.Root 当根时,Base UI 没见到打开它的 contextmenu 事件,按触屏长按处理 ——
 * 开出后 500ms 内的 outside press 全丢,还整页盖一层 modal 背板。所以这里用 CDP 发真鼠标 / 真触摸,并把时间卡在 500ms 以内。
 */
import { afterEach, expect, it, vi } from 'vitest';
import { cdp, page, userEvent } from 'vitest/browser';
import { act } from 'react';
import { createReactHarness, message, renderWithAppProviders } from '../../../../../../../tests/support/testHarness';
import { until } from '../../../../../../../tests/support/awaitCondition';
import '@/styles/tokens.css';
import '@renderer/index.css';

vi.mock('@gugu/core/cloud/config', async (original) => ({ ...(await original<object>()), getSupabaseUrl: () => 'http://supabase.test.local', getSupabaseAnonKey: () => 'test-anon-key' }));
vi.mock('@/hooks/useAgentHarnessIdentity', () => ({ useAgentHarnessIdentity: () => 'codex' }));
const { MessageBubble } = await import('@/components/chat/MessageBubble');
const { DropdownMenu, MenuItem } = await import('@/components/ui/Menu');

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
async function send(method: string, params: object) {
  await act(async () => { await (cdp() as unknown as Session).send(method, params); });
}
const mouse = (type: string, x: number, y: number, extra: object = {}) => send('Input.dispatchMouseEvent', { type, ...toPage(x, y), ...extra });
async function press(x: number, y: number, button: 'left' | 'right') {
  await mouse('mousePressed', x, y, { button, buttons: button === 'left' ? 1 : 2, clickCount: 1 });
  await mouse('mouseReleased', x, y, { button, buttons: 0, clickCount: 1 });
}
const sleep = (ms: number) => act(() => new Promise<void>((resolve) => { setTimeout(resolve, ms); }));
const menus = () => document.querySelectorAll('[data-testid="message-action-menu"]');
const bubbles = () => [...harness.container.querySelectorAll<HTMLElement>('[data-testid="message-bubble-action-target"]')];

async function mount(count: number, { compactMobile = false, scroll = false } = {}) {
  await page.viewport(1280, 800);
  await mouse('mouseMoved', 5, 790);
  harness = createReactHarness();
  harness.container.className = 'gugu-skin emlight';
  harness.container.style.cssText = `position:fixed;left:20px;top:20px;width:900px;height:${scroll ? 300 : 700}px;padding-top:60px;overflow:auto`;
  harness.container.dataset.testid = 'chat-message-list';
  await renderWithAppProviders(harness, <>
    {Array.from({ length: count }, (_, index) => <MessageBubble key={index}
      msg={message({ id: `m${index}`, is_mine: false, content: `message ${index}: right-click it, then press somewhere else right away` })}
      isGroup compactMobile={compactMobile} onReaction={() => {}} onQuote={() => {}} onForward={() => {}} onDelete={() => {}} onEnterSelectMode={() => {}} />)}
  </>);
  return bubbles();
}

/** Right-click near the bubble's left edge: the menu opens under the pointer, so its right end stays clear. */
async function rightClick(bubble: HTMLElement) {
  const rect = bubble.getBoundingClientRect();
  const at = { x: rect.left + 12, y: rect.top + rect.height / 2 };
  await mouse('mouseMoved', at.x, at.y);
  await mouse('mouseMoved', at.x + 1, at.y);
  expect(bubble.contains(document.elementFromPoint(at.x + 1, at.y)), 'the right click lands on the bubble').toBe(true);
  const before = menus()[0];
  await press(at.x + 1, at.y, 'right');
  await until('the context menu opens', () => menus().length === 1 && menus()[0] !== before);
}

/** The right end of a bubble: clear of a menu opened at another bubble's left edge. */
async function leftClickEnd(bubble: HTMLElement) {
  const rect = bubble.getBoundingClientRect();
  const at = { x: rect.right - 12, y: rect.top + 4 };
  expect(bubble.contains(document.elementFromPoint(at.x, at.y)), 'the press lands on the bubble itself, not on a menu or backdrop').toBe(true);
  await press(at.x, at.y, 'left');
}

it.each([50, 250])('a left click on the bubble %ims after the right click closes the menu', async (delay) => {
  const [bubble] = await mount(1);
  await rightClick(bubble);
  await sleep(delay);
  await leftClickEnd(bubble);
  await until('the menu closes', () => menus().length === 0);
});

// owner 11-09:成员行「⋯」点了又点,菜单不关反而一直开着。按钮打开的菜单 = 那颗按钮是 Trigger:
// 再按同一颗就关,按另一行的就挪过去(只开着一个),外面一按就关。真鼠标(CDP),pointerdown 与 click 各自到。
it('a menu opened from a button: a second press on it closes, another row moves it, an outside press closes', async () => {
  const handle = DropdownMenu.createHandle<string>();
  function Host() {
    return <>
      {['a', 'b'].map((row, index) => <DropdownMenu.Trigger key={row} handle={handle} payload={row} data-testid={`opener-${row}`}
        style={{ position: 'fixed', left: 100, top: 100 + index * 200, width: 40, height: 30 }}>{row}</DropdownMenu.Trigger>)}
      <DropdownMenu.Root handle={handle} modal={false}>
        {({ payload }) => <DropdownMenu.Content><MenuItem data-testid={`row-${payload}`}>{payload}</MenuItem></DropdownMenu.Content>}
      </DropdownMenu.Root>
    </>;
  }
  const rows = () => document.querySelectorAll('[data-testid^="row-"]');
  await page.viewport(1280, 800);
  harness = createReactHarness();
  await renderWithAppProviders(harness, <Host />);
  await press(108, 108, 'left');
  await until('the menu opens', () => !!document.querySelector('[data-testid="row-a"]'));
  await sleep(50);
  await press(108, 108, 'left');
  await until('a second press on the same button closes it', () => rows().length === 0);
  await sleep(300);
  expect(rows(), 'and it stays closed').toHaveLength(0);
  await press(108, 108, 'left');
  await until('it opens again', () => !!document.querySelector('[data-testid="row-a"]'));
  await press(108, 308, 'left');
  await until('another row moves the one menu', () => !!document.querySelector('[data-testid="row-b"]') && rows().length === 1);
  await sleep(50);
  await press(700, 600, 'left');
  await until('an outside press closes it', () => rows().length === 0);
});

it('right-clicking another message moves the one menu there; a click on another row closes it', async () => {
  // Bottom row first: its menu opens downward, so the top row stays clear for the second right click.
  const [first, second, third] = await mount(3);
  await rightClick(third);
  const before = menus()[0];
  await rightClick(first);
  await until('the first menu is gone', () => !before.isConnected);
  expect(menus()).toHaveLength(1);
  await leftClickEnd(second);
  await until('the menu closes', () => menus().length === 0);
});

it('the list under an open menu still scrolls, and never shows two menus', async () => {
  const [first] = await mount(12, { scroll: true });
  await rightClick(first);
  const list = harness.container;
  const rect = list.getBoundingClientRect();
  await mouse('mouseWheel', rect.right - 30, rect.bottom - 30, { deltaX: 0, deltaY: 200 });
  await until('the list scrolls', () => list.scrollTop > 0);
  expect(menus().length).toBeLessThanOrEqual(1);
});

it('Esc closes the menu and focus returns to where it was; arrow keys move through the rows', async () => {
  const [bubble] = await mount(1);
  const input = document.createElement('textarea');
  input.style.cssText = 'position:fixed;left:20px;top:740px';
  document.body.appendChild(input);
  try {
    input.focus();
    await rightClick(bubble);
    await userEvent.keyboard('{ArrowDown}');
    await until('a row is highlighted', () => !!menus()[0]?.querySelector('[data-highlighted]'));
    const first = menus()[0].querySelector('[data-highlighted]');
    await userEvent.keyboard('{ArrowDown}');
    await until('the highlight moves', () => { const now = menus()[0]?.querySelector('[data-highlighted]'); return !!now && now !== first; });
    await userEvent.keyboard('{Escape}');
    await until('the menu closes', () => menus().length === 0);
    await until('focus returns to the input', () => document.activeElement === input);
    // An outside press onto another field keeps the focus there.
    await rightClick(bubble);
    const other = document.createElement('textarea');
    other.style.cssText = 'position:fixed;left:400px;top:740px';
    document.body.appendChild(other);
    const box = other.getBoundingClientRect();
    await press(box.left + 10, box.top + 10, 'left');
    await until('the menu closes', () => menus().length === 0);
    await sleep(300);
    expect(document.activeElement).toBe(other);
    other.remove();
  } finally {
    input.remove();
  }
});

it('moving into the fold submenu and back keeps the menu open', async () => {
  const [bubble] = await mount(1);
  await rightClick(bubble);
  await userEvent.hover(page.getByTestId('message-action-more'));
  await expect.element(page.getByTestId('message-action-delete')).toBeVisible();
  await userEvent.hover(page.getByTestId('message-action-select'));
  await userEvent.hover(page.getByTestId('message-action-delete'));
  expect(menus(), 'moving inside the submenu keeps both open').toHaveLength(1);
  await userEvent.hover(page.getByTestId('message-action-copy'));
  await until('the submenu closes', () => !document.querySelector('[data-testid="message-action-delete"]'));
  expect(menus()).toHaveLength(1);
  await userEvent.hover(page.getByTestId('message-action-more'));
  await expect.element(page.getByTestId('message-action-delete')).toBeVisible();
});

it('on a phone, lifting the finger after a long press leaves the menu open', async () => {
  const [bubble] = await mount(1, { compactMobile: true });
  const rect = bubble.getBoundingClientRect();
  const at = toPage(rect.left + 20, rect.top + rect.height / 2);
  // No Emulation.setTouchEmulationEnabled: it outlives the file and turns later files' mouse hovers off.
  await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [at] });
  await until('the long press opens the menu', () => menus().length === 1);
  await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(400);
  expect(menus(), 'the release must not dismiss the menu that grew under the finger').toHaveLength(1);
});
