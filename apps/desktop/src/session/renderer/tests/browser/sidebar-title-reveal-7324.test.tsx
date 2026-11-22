import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cdp, userEvent } from 'vitest/browser';
import { until } from '../../../../../../../tests/support/awaitCondition';
import { presentAgentStatus } from '@gugu/core/shared/agentStatusPresentation';
import { SessionRowShell } from '@renderer/features/sidebar/sidebar-session-row';
import { SessionLocalizationProvider } from '@renderer/localization/localization-provider';
import { translateSessionMessage } from '@renderer/localization/locale-store';
import '@/styles/tokens.css';
import '@renderer/index.css';

const LONG_TITLE = '打开百度搜索并注册 AI 网站，然后核对新用户注册和邮件通知的完整流程';
let root: Root;
let host: HTMLDivElement;
let park: HTMLDivElement;
const onOpen = vi.fn();
const onDragStart = vi.fn((event: React.DragEvent) => event.dataTransfer.setData('text/plain', 'title-reveal'));
const media = (reducedMotion: 'reduce' | 'no-preference') =>
  cdp().send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: reducedMotion }] });

beforeEach(async () => {
  host = document.createElement('div');
  host.className = 'gugu-skin emlight';
  host.style.width = '260px';
  document.body.append(host);
  root = createRoot(host);
  park = document.createElement('div');
  park.style.cssText = 'position:fixed;right:0;bottom:0;width:80px;height:80px';
  document.body.append(park);
  await userEvent.hover(park);
  await media('no-preference');
  onOpen.mockClear();
  onDragStart.mockClear();
});

afterEach(async () => {
  root.unmount(); host.remove(); park.remove(); vi.restoreAllMocks();
  await media('no-preference');
});

async function mount(title = LONG_TITLE) {
  root.render(
    <SessionLocalizationProvider>
      <SessionRowShell
        sessionId="title-reveal" rowVariant="tree" depth={0} hasChildren={false} expanded={false}
        title={title} harness={null} presentation={presentAgentStatus({ reading: { status: 'idle', detail: null } })} lastInteractedAt={new Date().toISOString()}
        doneUnread={false} isActive={false} isCursor={false} isPendingArchive={false}
        quickActions={{ isPinned: false, onSetPinned: () => {}, archiveLabel: 'Archive', onArchive: () => {} }}
        onOpen={onOpen}
        rowProps={{ draggable: true, onDragStart }}
      />
    </SessionLocalizationProvider>,
  );
  await until('session row rendered', () => host.querySelector('[data-session-id]')?.textContent?.includes(title) ?? false);
  return host.querySelector<HTMLElement>('[data-session-id]')!;
}

const viewport = () => host.querySelector<HTMLElement>('[data-session-id] button span[data-reveal]')!;
const track = () => viewport().firstElementChild as HTMLElement;
const x = () => new DOMMatrix(getComputedStyle(track()).transform).m41;
function runningAnimation() {
  const animation = track().getAnimations()[0];
  expect(animation, 'the actual hovered title must have a browser animation').toBeDefined();
  return animation;
}

it('reveals only an overflowing title, stops with the full end readable, and resets on leave', async () => {
  const row = await mount();
  await until('long title measured', () => viewport() != null);
  const before = viewport().getBoundingClientRect();
  // The actions layer itself (the slot around it is only as wide as the time/status).
  const actions = host.querySelector<HTMLElement>('[data-row-hover-actions] > :first-child')!;
  const actionsBefore = actions.getBoundingClientRect();
  expect(before.width).toBeGreaterThan(0);
  expect(track().getBoundingClientRect().width).toBeGreaterThan(before.width);
  expect(track().getAnimations()).toHaveLength(0);
  expect(row.querySelector('button')?.getAttribute('aria-label')).toBe(translateSessionMessage('sidebar.openConversation', { title: LONG_TITLE }));

  await userEvent.hover(row);
  await until('hover starts the reveal', () => track().getAnimations().length === 1);
  // The actions are drawn over the title's tail (owner 11-22, b): hovering changes neither the title's lane
  // nor where the actions sit, so nothing re-measures and the reveal runs once from the start.
  const hovered = viewport().getBoundingClientRect();
  const actionsHovered = actions.getBoundingClientRect();
  expect(hovered.width).toBe(before.width);
  expect(hovered.right).toBe(before.right);
  expect(actionsHovered.left).toBe(actionsBefore.left);
  expect(actionsHovered.left, 'the actions cover the title tail').toBeLessThan(hovered.right);
  expect(getComputedStyle(viewport()).maskImage, 'the title fades out before the actions').toContain('calc(');
  const animation = runningAnimation();
  animation.pause();
  animation.currentTime = 200;
  expect(x()).toBe(0); // The opening pause lets the start be read first.
  const timing = animation.effect!.getComputedTiming();
  animation.currentTime = Number(timing.endTime) / 2;
  expect(x()).toBeLessThan(0);
  animation.finish();
  viewport().getAnimations().forEach((a) => a.finish());
  const end = track().getBoundingClientRect();
  // The whole end is readable: it stops just left of the first action, not under it.
  expect(end.right).toBeLessThanOrEqual(actionsHovered.left);
  expect(end.right).toBeGreaterThanOrEqual(actionsHovered.left - 4.5);

  await userEvent.hover(park);
  await until('leaving resets the reveal', () => track().getAnimations().length === 0);
  expect(viewport().getBoundingClientRect().width).toBe(before.width);
  expect(x()).toBe(0);
});

it('keeps the title width when a quick-action button receives keyboard focus, fading the title before it', async () => {
  const row = await mount();
  await until('long title measured', () => viewport() != null);
  const idleWidth = viewport().getBoundingClientRect().width;
  const idleMask = getComputedStyle(viewport()).maskImage;
  await userEvent.keyboard('{Tab}{Tab}{Tab}');
  const actions = host.querySelector<HTMLElement>('[data-row-hover-actions]')!;
  expect(actions.contains(document.activeElement)).toBe(true);
  expect(document.activeElement).toBe(actions.querySelector('button'));
  const layer = actions.firstElementChild as HTMLElement;
  await until('focused actions are shown', () => Number(getComputedStyle(layer).opacity) === 1);
  expect(viewport().getBoundingClientRect().width).toBe(idleWidth);
  // Not the resting 1em fade at the very end: the fade now ends where the actions begin.
  expect(getComputedStyle(viewport()).maskImage).not.toBe(idleMask);
  expect(row.contains(document.activeElement)).toBe(true);
});

it('reveals a title that fits at rest but would run under the actions', async () => {
  // Fits the lane beside the time, but its end sits where the actions are drawn.
  const row = await mount('打开百度搜索并注册 AI 网站');
  const lane = row.querySelector<HTMLElement>('button.flex-1 > span:last-child')!;
  const text = () => { const r = document.createRange(); r.selectNodeContents(lane.firstElementChild!); return r.getBoundingClientRect(); };
  const actions = host.querySelector<HTMLElement>('[data-row-hover-actions] > :first-child')!;
  // Size the row so the lane is 8px wider than the title.
  host.style.width = `${260 - lane.clientWidth + text().width + 8}px`;
  await until('title fits at rest yet reaches under the actions', () =>
    text().right <= lane.getBoundingClientRect().right && text().right > actions.getBoundingClientRect().left
    && lane.hasAttribute('data-reveal'));
  expect(host.querySelector('[data-overflow]'), 'no resting fade for a title that fits').toBeNull();
  await userEvent.hover(row);
  await until('reveal runs', () => track().getAnimations().length === 1);
  runningAnimation().finish();
  expect(text().right).toBeLessThanOrEqual(actions.getBoundingClientRect().left);
});

it('does not animate a short title and preserves row activation', async () => {
  const row = await mount('短标题');
  await userEvent.hover(row);
  expect(host.querySelector('[data-overflow]')).toBeNull();
  expect(host.querySelector('[data-reveal]')).toBeNull();
  expect(row.getAnimations({ subtree: true }).filter((a) => a.effect?.getTiming().fill === 'forwards')).toHaveLength(0);
  await userEvent.click(row.querySelector('button')!);
  expect(onOpen).toHaveBeenCalledTimes(1);
});

it('preserves a title click when its measured text is replaced while pressed', async () => {
  const row = await mount();
  await until('long title measured', () => viewport() != null);
  const idleWidth = viewport().clientWidth;
  await userEvent.hover(row);
  await until('hover starts the reveal', () => track().getAnimations().length === 1);
  const originalTrack = track();
  const pressedWidth = viewport().clientWidth;
  expect(pressedWidth).toBe(idleWidth);
  const rect = viewport().getBoundingClientRect();
  const point = { x: rect.left + 20, y: rect.top + rect.height / 2 };
  let pressed = false;
  row.addEventListener('mousedown', () => { pressed = true; }, { once: true });
  await cdp().send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
  await cdp().send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', buttons: 1, clickCount: 1 });
  try {
    expect(pressed, 'the pointer must press the actual row').toBe(true);
    host.style.width = '230px';
    await until('resized text replaced', () => track() !== originalTrack && viewport().clientWidth < pressedWidth);
  } finally {
    await cdp().send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', buttons: 0, clickCount: 1 });
  }
  expect(onOpen).toHaveBeenCalledTimes(1);
});

it('remeasures the lane when resized and removes motion when the title fits', async () => {
  const row = await mount();
  await until('long title measured', () => viewport() != null);
  await userEvent.hover(row);
  runningAnimation().finish();
  host.style.width = '1200px';
  await until('wide lane fits', () => host.querySelector('[data-overflow]') === null);
  host.style.width = '260px';
  await until('narrow lane measured', () => viewport() != null);
  expect(track().getBoundingClientRect().width).toBeGreaterThan(viewport().clientWidth);
});

it('reveals the title for keyboard focus and still allows dragging from the title', async () => {
  const row = await mount();
  await until('long title measured', () => viewport() != null);
  await userEvent.keyboard('{Tab}');
  await until('keyboard focuses row', () => document.activeElement === row);
  runningAnimation().finish();
  await userEvent.keyboard('{Tab}');
  expect(document.activeElement).toBe(row.querySelector('button'));
  expect(track().getAnimations()).toHaveLength(1);
  await userEvent.dragAndDrop(row.querySelector('button')!, park);
  expect(onDragStart).toHaveBeenCalledTimes(1);
});

it('resets a replaced title and exposes its complete text without motion for reduced motion users', async () => {
  let row = await mount();
  await until('long title measured', () => viewport() != null);
  await userEvent.hover(row);
  runningAnimation().finish();
  await media('reduce');
  row = await mount(`${LONG_TITLE}（重新命名）`);
  await userEvent.hover(row);
  expect(viewport().title).toBe(`${LONG_TITLE}（重新命名）`);
  // The reveal is two CSS animations (revealTitle on the track, revealEnd on the viewport); none may run.
  // ❌ Not "no Animation objects": under reduced motion index.css turns every style change into a 0.01ms
  // transition (here `scrollbar-color` on hover) that only ends on the next frame — a race the assertion
  // lost 9/10 on a slow frame clock (mac1 over SSH) and won on CI's 60fps.
  expect([viewport(), track()].flatMap((el) => el.getAnimations()).filter((a) => a instanceof CSSAnimation)).toHaveLength(0);
  expect(x()).toBe(0);
});
