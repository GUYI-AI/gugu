import { DndContext } from '@dnd-kit/core';
import { act, type ReactNode } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cdp, page, userEvent } from 'vitest/browser';
import { createReactHarness } from '../../../../../../../tests/support/testHarness';
import { until, untilStable } from '../../../../../../../tests/support/awaitCondition';
import { createTabProvider, createTabRegistry } from '@renderer/features/tabs/core/tab-provider-registry';
import { PaneLayoutStore } from '@renderer/features/tabs/pane-layout-store';
import { PaneTreeView } from '@renderer/features/tabs/pane-tree-view';
import { PaneContent } from '@renderer/features/tabs/pane-content';
import { PaneProvider } from '@renderer/features/tabs/pane-context';
import { Button } from '@renderer/lib/ui/button';
import { Plus } from '@/lib/icons';
import { TabBarActionRow } from '@renderer/features/sessions/titlebar-actions';
import { GenericTabDragPreview, GenericTabItem } from '@renderer/features/tabs/tab-bar/generic-tab-item';
import { PaneLayoutProvider } from '@renderer/features/tabs/pane-layout-context';
import { TabDragOverlay } from '@renderer/features/tabs/tab-bar/tab-drag-preview';
import { useTabDrag } from '@renderer/features/tabs/use-tab-drag';
import { edgeFirst } from '@renderer/features/tabs/pane-edge-drop';
import { i18n } from '@/i18n';
import '@renderer/index.css';
import '@/styles/tokens.css';

const provider = (kind: string, rename?: (name: string) => void) => createTabProvider({
  kind,
  conversation: kind === 'conversation',
  resourceKey: (state: { id: string }) => state.id,
  initialize: () => ({ dispose() {} }),
  dispose() {},
  TabContent: () => <div data-chat-workspace-test-body={kind}>{kind === 'conversation' ? '聊天正文' : '工具正文'}</div>,
  commands: kind === 'conversation' && rename ? {
    rename: { label: 'Rename', exec: (_resource, name?: string) => { if (name) rename(name); } },
  } : undefined,
  TabBarItem: ({ tab, host, ctx }) => <GenericTabItem tab={tab} host={host} ctx={ctx}
    label={kind === 'conversation' ? '聊天标题' : '工具页签'} renameOnDoubleClick={kind === 'conversation' && !!rename} />,
  TabBarItemDragPreview: () => <GenericTabDragPreview label="工具页签" />,
});

let harness: ReturnType<typeof createReactHarness> | undefined;
let layout: PaneLayoutStore | undefined;
afterEach(() => { harness?.cleanup(); layout?.dispose(); harness = undefined; layout = undefined; });

function WorkspaceDrag({ layout, children }: { layout: PaneLayoutStore; children: ReactNode }) {
  const drag = useTabDrag({ layout, openWindow: () => null });
  return <PaneLayoutProvider paneLayout={layout}>
    <DndContext sensors={drag.sensors} collisionDetection={edgeFirst} onDragStart={drag.onDragStart} onDragEnd={drag.onDragEnd} onDragCancel={drag.onDragCancel}>
      {children}
      <TabDragOverlay />
    </DndContext>
  </PaneLayoutProvider>;
}

async function mountWorkspace(rename?: (name: string) => void) {
  // The tab labels asserted below are the zh-CN catalog's.
  await i18n.changeLanguage('zh-CN');
  await page.viewport(1220, 790);
  const view = harness = createReactHarness();
  view.container.classList.add('emlight', 'gugu-skin');
  view.container.style.cssText = 'position:fixed;left:0;top:0;width:1180px;height:580px;display:flex';
  const workspace = layout = new PaneLayoutStore(createTabRegistry(['conversation', 'tool'].map(kind => provider(kind, rename))), { viewId: 'chat-workspace-browser-test' }, undefined, {
    isPrimaryChatTab: (entry) => entry.kind === 'conversation',
    placementMemory: { read: () => undefined, write() {} },
  });
  workspace.open('conversation', { id: 'chat' }, { from: null, intent: 'newTab' });
  workspace.setViewActive(true);
  const openWindow = vi.fn();
  workspace.setWindowOpener((id) => id === workspace.primaryChatTabId ? openWindow : null);
  // `shown: false` takes the view away; drawn again, it mounts from nothing on the same store (a page re-mounted).
  const draw = (shown = true) => view.render(<WorkspaceDrag layout={workspace}>
    {/* Clipped like the app's shell around the panes (overflow hidden is still scrollable by script). */}
    {shown && <div style={{ width: 800, height: '100%', overflow: 'hidden' }} data-chat-workspace-test-main="">
      <PaneTreeView layout={workspace} chatChrome={{
        actions: <TabBarActionRow><span>聊天操作</span></TabBarActionRow>,
        addTab: <Button size="icon-sm" variant="ghost" aria-label="打开测试工具" onClick={() => workspace.open('tool', { id: 'file' }, { from: null, intent: 'newTab' })}><Plus className="size-3.5" /></Button>,
      }} renderPane={(paneId, _first, _last, part) => {
        const group = workspace.groups.find((pane) => pane.paneId === paneId)!;
        return <PaneProvider group={group} isFocusedPane={group === workspace.groups.find((candidate) => candidate.paneId === workspace.activePaneId)}><PaneContent part={part} /></PaneProvider>;
      }} />
    </div>}
    <aside style={{ width: 380, height: '100%' }} data-chat-workspace-test-neighbour="">另一条聊天</aside>
  </WorkspaceDrag>);
  await act(() => draw());
  const inside = (selector: string) => view.container.querySelector<HTMLElement>(selector);
  const width = (element: HTMLElement | null | undefined) => element?.getBoundingClientRect().width ?? 0;
  const mode = (value: string) => until(`shows the ${value} chat header`, () => !!inside(`[data-chat-workspace-header="${value}"]`));
  const chat = () => inside('[data-chat-workspace-test-body="conversation"]');
  const tool = () => inside('[data-chat-workspace-test-body="tool"]');
  const neighbour = () => inside('[data-chat-workspace-test-neighbour]')!;
  return { inside, width, mode, chat, tool, neighbour, workspace, openWindow, draw };
}

it('renames the standalone chat title on double-click only, and cancels with Escape', async () => {
  const rename = vi.fn();
  const { mode, inside } = await mountWorkspace(rename);
  await mode('empty');
  const title = page.getByText('聊天标题');
  const input = page.getByRole('textbox', { name: '会话名称' });
  await userEvent.click(title);
  expect(inside('input')).toBeNull();
  await userEvent.dblClick(title);
  await expect.element(input).toHaveValue('聊天标题');
  await input.fill('放弃修改');
  await userEvent.keyboard('{Escape}');
  expect(rename).not.toHaveBeenCalled();
  await userEvent.dblClick(title);
  await input.fill('  新名字  ');
  await userEvent.keyboard('{Enter}');
  expect(rename).toHaveBeenCalledExactlyOnceWith('新名字');
});

it('opens the first tool into a split, hides/restores it and expands only its own block', async () => {
  const { inside, width, mode, chat, tool, neighbour, openWindow } = await mountWorkspace();
  const neighbourBefore = neighbour().getBoundingClientRect().toJSON();
  await mode('empty');
  expect(inside('[data-chat-workspace-title]')?.textContent).toContain('聊天标题');
  // The conversation's own head is the design's 56px capsule row (.capbar).
  expect(inside('[data-chat-workspace-header]')?.getBoundingClientRect().height).toBe(56);
  expect(inside('[data-chat-workspace-header] [data-tab-label]')).toBeNull();
  expect(tool()).toBeNull();
  expect(page.getByRole('button', { name: '单独成窗' }).query()).toBeNull();
  // 第 16 版: the capsule row draws no ⋯ (its actions are in the card and Details); the tab's own window command is on right-click.
  expect(page.getByRole('button', { name: /^(?:More|更多)$/ }).query()).toBeNull();
  await userEvent.click(page.getByText('聊天标题'), { button: 'right' });
  await userEvent.click(page.getByRole('menuitem', { name: '在新窗口打开' }));
  expect(openWindow).toHaveBeenCalledOnce();
  await userEvent.click(page.getByRole('button', { name: '打开测试工具' }));
  await mode('split');
  await until('the split produces two measurable pages', () => width(chat()) > 0 && width(tool()) > 0 && width(tool()) < 800);
  // The tool slides in on the track: the split width to restore is the one it lands on.
  await untilStable('the split comes to rest', () => width(chat()));
  const chip = inside('[data-chat-workspace-header] [data-tab-label="工具页签"]')!;
  const hideButton = inside('button[aria-label="隐藏标签页"]')!;
  // The tools' strip follows the design's .tab: 34px tall, 9px corners.
  expect(chip.getBoundingClientRect().height).toBe(34);
  expect(getComputedStyle(chip).borderBottomLeftRadius).toBe('9px');
  // Side by side the tools are a card of their own: its 46px strip (the design's .strip) carries the view buttons.
  expect(hideButton.getBoundingClientRect()).toMatchObject({ width: 28, height: 28, y: 9 });
  expect(hideButton.closest('[data-chat-tool-strip]')).not.toBeNull();
  expect(getComputedStyle(inside('[data-chat-tool-strip]')!).borderTopLeftRadius).toBe('12px');
  expect(inside('[data-chat-tool-card]')).not.toBeNull();
  expect(getComputedStyle(hideButton).borderRadius).toBe('8px');
  expect(hideButton.getAttribute('aria-pressed')).toBe('true');
  const panelIcon = hideButton.querySelector('svg')?.innerHTML;
  expect(panelIcon).toBeTruthy();
  const firstTool = tool();
  const chatWidth = width(chat());

  await userEvent.click(page.getByRole('button', { name: '隐藏标签页' }));
  // The tool goes out on the track — live, ❌ blank at once or a picture of it — sliding with the edge, and the chat beside
  // it is laid out at every width it is drawn at. Its tabs above move with it on the same edge (@@@strip-on-track).
  const toolLefts = new Set<number>();
  const chatWidths = new Set<number>();
  const strayStrip: string[] = [];
  const stripOnEdge = () => {
    const column = inside('[data-chat-workspace-chat-header]');
    const tools = inside('[data-chat-workspace-header] [data-tab-label="工具页签"]')?.closest<HTMLElement>('.absolute');
    const toolPage = tool() && !tool()!.closest('[inert]') ? tool()!.getBoundingClientRect().left : null;
    const header = inside('[data-chat-workspace-header]')!.getBoundingClientRect().right;
    if (tools && toolPage !== null && toolPage < header - 100 && Math.abs(tools.getBoundingClientRect().left - toolPage) > 2) strayStrip.push(`tabs ${Math.round(tools.getBoundingClientRect().left)}≠page ${Math.round(toolPage)}`);
    const edge = chat()?.getBoundingClientRect().right ?? 0;
    if (column && tools && edge < header - 100 && Math.abs(column.getBoundingClientRect().right - edge) > 2) strayStrip.push(`chat ${Math.round(column.getBoundingClientRect().right)}≠${Math.round(edge)}`);
  };
  for (let frame = 0; frame < 40; frame += 1) {
    await new Promise(requestAnimationFrame);
    if (firstTool && !firstTool.closest('[inert]')) toolLefts.add(Math.round(firstTool.getBoundingClientRect().left));
    chatWidths.add(Math.round(width(chat())));
    stripOnEdge();
  }
  expect(toolLefts.size, [...toolLefts].join(' ')).toBeGreaterThan(2);
  expect(chatWidths.size, [...chatWidths].join(' ')).toBeGreaterThan(2);
  expect(strayStrip, 'the strip and the pages share the edge in every frame').toEqual([]);
  await mode('hidden');
  const showButton = inside('button[aria-label="显示标签页"]')!;
  expect(showButton.getAttribute('aria-pressed')).toBe('false');
  expect(showButton.querySelector('svg')?.innerHTML).toBe(panelIcon);
  // Folded, the button sits on the capsule row's middle line (.capbar .rt: 28px box in the 56px row).
  expect(showButton.getBoundingClientRect()).toMatchObject({ width: 28, height: 28, y: 14 });
  // …and floats there: the capsule row keeps the whole card's width, so the capsule centres on the card.
  expect(inside('[data-chat-workspace-chat-header]')!.getBoundingClientRect().width).toBe(inside('[data-chat-workspace-header]')!.getBoundingClientRect().width);
  expect(getComputedStyle(showButton).borderRadius).toBe('8px');
  await until('the chat uses the full width of its own block', () => width(chat()), (size) => size === 800);
  // The tool goes out on the track and is out of reach once it lands.
  await until('the hidden tool is out of reach', () => !!firstTool?.closest('[inert]'));
  await userEvent.click(page.getByRole('button', { name: '显示标签页' }));
  await mode('split');
  // Shown again, the tool comes in on the track like a new one, ❌ in one frame, its tabs on the same edge.
  const shownLefts = new Set<number>();
  for (let frame = 0; frame < 20; frame += 1) {
    await new Promise(requestAnimationFrame);
    shownLefts.add(Math.round(tool()?.getBoundingClientRect().left ?? -1));
    stripOnEdge();
  }
  // Over several frames (how many a runner catches is the machine's).
  expect(shownLefts.size, [...shownLefts].join(' ')).toBeGreaterThan(2);
  expect(strayStrip, 'the strip and the pages share the edge in every frame').toEqual([]);
  await until('the original split width is restored', () => width(chat()), (size) => size === chatWidth);

  await userEvent.click(page.getByRole('button', { name: '进入完整视图' }));
  await mode('full');
  await until('the tool fills the chat block', () => width(tool()), (size) => size === 800);
  expect(tool()).toBe(firstTool);
  await until('the chat under the full view is out of reach', () => !!chat()?.closest('[inert]'));
  expect(neighbour().getBoundingClientRect().toJSON()).toEqual(neighbourBefore);
  await userEvent.click(page.getByRole('button', { name: '退出全屏' }));
  await mode('split');
  await until('leaving the full view restores its split', () => width(chat()), (size) => size === chatWidth);
  await userEvent.click(page.getByRole('button', { name: '进入完整视图' }));
  await mode('full');
  await userEvent.keyboard('{Escape}');
  await mode('split');
  await userEvent.click(page.getByRole('button', { name: /^(?:关闭工具页签标签|Close 工具页签 tab)$/ }));
  await mode('empty');
  await until('the chat fills its block after the last tool closes', () => width(chat()), (size) => size === 800);
  // It goes out on the track, live (@@@closing-pane), and is gone once it lands.
  await until('the closed tool is gone', () => !tool());
});

it('lands on the same layout however often it is toggled and resized mid-move', async () => {
  const { inside, width, mode, chat, tool } = await mountWorkspace();
  await mode('empty');
  await userEvent.click(page.getByRole('button', { name: '打开测试工具' }));
  await mode('split');
  await untilStable('the split comes to rest', () => width(chat()));
  const splitChat = width(chat());
  const main = inside('[data-chat-workspace-test-main]')!;
  const toggle = () => inside('button[aria-label="隐藏标签页"], button[aria-label="显示标签页"]')!.click();
  const frames = async (count: number) => { for (let at = 0; at < count; at += 1) await new Promise(requestAnimationFrame); };
  // Ten toggles, each cut short, with the block resized under them (a sidebar folding beside it): back to the split.
  for (let at = 0; at < 10; at += 1) {
    toggle();
    await frames(1 + (at % 3) * 3);
    main.style.width = at % 2 ? '760px' : '800px';
    await frames(2);
  }
  main.style.width = '800px';
  await mode('split');
  await until('the split lands where it was', () => width(chat()), (size) => Math.abs(size - splitChat) <= 1);
  const column = inside('[data-chat-workspace-chat-header]')!;
  await until('the strip lands on the same edge', () => Math.abs(column.getBoundingClientRect().right - chat()!.getBoundingClientRect().right) <= 2);
  // Hidden, then resized at rest: the chat takes the whole block at every width (❌ the hidden tool's minimum kept).
  toggle();
  await mode('hidden');
  await until('the hidden tool is out of reach', () => !!tool()?.closest('[inert]'));
  for (const size of [700, 800, 640, 800]) {
    main.style.width = `${size}px`;
    await until(`the chat fills ${size}px`, () => width(chat()), (value) => value === size);
  }
});

it('mounts a workspace whose tools are hidden with the chat already at full width, ❌ springing the tools shut', async () => {
  const { width, mode, chat, draw } = await mountWorkspace();
  await userEvent.click(page.getByRole('button', { name: '打开测试工具' }));
  await mode('split');
  await untilStable('the split comes to rest', () => width(chat()));
  await userEvent.click(page.getByRole('button', { name: '隐藏标签页' }));
  await mode('hidden');
  await until('the chat uses the full width of its own block', () => width(chat()), (size) => size === 800);

  // Its page taken away and drawn again from nothing (a block re-mounted): the hidden tools are where they were, from the
  // first frame.
  await act(() => draw(false));
  await new Promise(requestAnimationFrame);
  await act(() => draw());
  const chatWidths: number[] = [];
  for (let frame = 0; frame < 30; frame += 1) {
    chatWidths.push(Math.round(width(chat())));
    await new Promise(requestAnimationFrame);
  }
  expect(chatWidths.every((size) => size === 800), chatWidths.join(' ')).toBe(true);
});

it('a move held back by a long frame goes on from where it was drawn, ❌ skipped ahead by the time it was held', async () => {
  const { width, mode, chat, tool } = await mountWorkspace();
  await userEvent.click(page.getByRole('button', { name: '打开测试工具' }));
  await mode('split');
  await untilStable('the split comes to rest', () => width(chat()));
  const landing = Math.round(tool()!.getBoundingClientRect().left);
  await userEvent.click(page.getByRole('button', { name: '隐藏标签页' }));
  await mode('hidden');
  await until('the hidden tool is out of reach', () => !!tool()?.closest('[inert]'));
  // A first open mounts its pages: the frames right after the move starts are held back. The window hears the click after
  // the app (which starts the move), in the same task. The frames are counted from there, ❌ from when the click's round
  // trip to the test driver returns: on a slow runner a few frames have gone by then.
  const lefts: number[] = [];
  const sample = () => {
    lefts.push(Math.round(tool()!.getBoundingClientRect().left));
    if (lefts.length < 30) requestAnimationFrame(sample);
  };
  window.addEventListener('click', () => {
    const held = performance.now();
    while (performance.now() - held < 300) { /* a long task */ }
    requestAnimationFrame(sample);
  }, { once: true });
  await userEvent.click(page.getByRole('button', { name: '显示标签页' }));
  await until('30 frames of the move are sampled', () => lefts.length === 30);
  const travel = 800 - landing;
  // The first frame shown is near the start (a frame's step, ❌ 300 ms of a 500 ms move), and the rest still slides.
  expect(800 - lefts[0], JSON.stringify(lefts)).toBeLessThan(travel / 4);
  expect(new Set(lefts).size, JSON.stringify(lefts)).toBeGreaterThan(5);
});

it('the conversation keeps its look through a move: a title, narrow or not by its width at rest, ❌ as drawn mid-move', async () => {
  const { inside, width, mode, chat, tool } = await mountWorkspace();
  await userEvent.click(page.getByRole('button', { name: '打开测试工具' }));
  await mode('split');
  await untilStable('the split comes to rest', () => width(chat()));
  const bar = () => inside('[data-chat-workspace-chat-header] .session-tab-bar');
  // At rest beside the tools the conversation strip is narrow (under 600 px here), alone it is not.
  expect(bar()!.hasAttribute('data-strip-narrow')).toBe(true);
  const looks = async () => {
    const seen = new Set<string>();
    for (let frame = 0; frame < 40; frame += 1) {
      await new Promise(requestAnimationFrame);
      const look = `title=${!!inside('[data-chat-workspace-title]')} tab=${!!inside('[data-chat-workspace-conversation-tab]')}`;
      if (tool() && !tool()!.closest('[inert]')) seen.add(`${look} narrow=${bar()?.hasAttribute('data-strip-narrow')}`);
    }
    return [...seen];
  };
  await userEvent.click(page.getByRole('button', { name: '隐藏标签页' }));
  expect(await looks(), 'hiding: while the tools are on screen, one look').toEqual(['title=true tab=false narrow=true']);
  await mode('hidden');
  await until('the hidden tool is out of reach', () => !!tool()?.closest('[inert]'));
  expect(bar()!.hasAttribute('data-strip-narrow')).toBe(false);
  await userEvent.click(page.getByRole('button', { name: '显示标签页' }));
  expect(await looks(), 'showing: while the tools are on screen, one look').toEqual(['title=true tab=false narrow=true']);
});

it('keeps the conversation as the first tab of the strip however narrow, and keeps both pages alive', async () => {
  const { inside, workspace, chat, tool, mode, width } = await mountWorkspace();
  await userEvent.click(page.getByRole('button', { name: '打开测试工具' }));
  await mode('split');
  const originalChat = chat(), originalTool = tool();
  await act(() => workspace.setChatToolLayout('full'));
  await mode('full');
  await userEvent.click(page.getByRole('button', { name: '聊天标题', exact: true }));
  await until('conversation occupies the existing single pane', () => width(chat()), value => value === 800);
  expect(workspace.chatWorkspaceMode).toBe('full');
  expect(chat()).toBe(originalChat);
  await userEvent.click(page.getByText('工具页签', { exact: true }));
  await act(() => { inside('[data-chat-workspace-test-main]')!.style.width = '560px'; });
  const firstTab = () => inside('[data-chat-workspace-header] [data-tabid]');
  await until('chat stays the first tab of the compact strip', () => firstTab()?.hasAttribute('data-chat-workspace-conversation-tab') ?? false);
  await act(() => { inside('[data-chat-workspace-test-main]')!.style.width = '380px'; });
  // Narrower still it is an ordinary tab: still first, only shrinking, ❌ moved to the action row or over the page.
  await until('the conversation is still the first tab', () => firstTab()?.hasAttribute('data-chat-workspace-conversation-tab') ?? false);
  await userEvent.click(page.getByRole('button', { name: '聊天标题', exact: true }));
  await until('the same conversation returns', () => chat()?.closest('[inert]') === null);
  expect(chat()).toBe(originalChat);
  expect(tool()).toBe(originalTool);
});

it('shrinks and scrolls the group strip with the selected tab still in view', async () => {
  const { inside, mode, workspace, chat, tool } = await mountWorkspace();
  await userEvent.click(page.getByRole('button', { name: '打开测试工具' }));
  await mode('split');
  await act(() => {
    for (let index = 0; index < 7; index += 1) {
      workspace.open('tool', { id: `extra-${index}` }, { from: null, intent: 'newTab' });
    }
    if (workspace.layout.type === 'split') workspace.setSplitSizes(workspace.layout.id, [59, 41]);
  });
  const activeTab = () => inside('[data-chat-workspace-header] [data-tab-label="工具页签"][data-tab-active]');
  const scroller = () => activeTab()?.closest<HTMLElement>('[data-tabstrip-scroller]');
  await until('the active tool scrolls into view as the strip gets narrow', () => {
    const active = activeTab()?.getBoundingClientRect();
    const strip = scroller()?.getBoundingClientRect();
    return !!active && !!strip && scroller()!.scrollLeft > 0 && active.left >= strip.left && active.right <= strip.right + 1;
  });
  expect(inside('[data-chat-workspace-header] [data-tabstrip-overflow]')).toBeNull();
  expect(activeTab()!.getBoundingClientRect().width).toBeCloseTo(84, 0);

  // Shown again with more tabs than fit, the strip reveals its tab by scrolling itself only: ❌ the clipped track around
  // the pages (scrollIntoView would shove the chat aside and drop the tool page in place in one frame).
  await userEvent.click(page.getByRole('button', { name: '隐藏标签页' }));
  await mode('hidden');
  await until('the hidden tools leave the strip once they land', () => !inside('[data-chat-workspace-header] [data-tab-label="工具页签"]'));
  await userEvent.click(page.getByRole('button', { name: '显示标签页' }));
  await mode('split');
  const shoved = new Set<string>();
  const toolLefts = new Set<number>();
  for (let frame = 0; frame < 20; frame += 1) {
    await new Promise(requestAnimationFrame);
    for (let node = chat()?.parentElement; node && node !== document.body; node = node.parentElement) {
      if (node.scrollLeft !== 0) shoved.add(`${node.className} scrollLeft=${node.scrollLeft}`);
    }
    toolLefts.add(Math.round(tool()?.getBoundingClientRect().left ?? -1));
  }
  expect([...shoved], 'nothing around the pages scrolls').toEqual([]);
  expect(toolLefts.size, [...toolLefts].join(' ')).toBeGreaterThan(2);
});

async function mouse(type: 'mouseMoved' | 'mousePressed' | 'mouseReleased', x: number, y: number, pressed = false) {
  for (let current: Window = window; current.frameElement; current = current.parent) {
    const frame = current.frameElement as HTMLElement;
    const box = frame.getBoundingClientRect();
    const scale = box.width / frame.offsetWidth;
    x = box.left + (frame.clientLeft + x) * scale;
    y = box.top + (frame.clientTop + y) * scale;
  }
  await act(async () => {
    await cdp().send('Input.dispatchMouseEvent', {
      type, x, y, button: type === 'mouseMoved' && !pressed ? 'none' : 'left',
      buttons: pressed ? 1 : 0, clickCount: type === 'mouseMoved' ? 0 : 1,
    });
  });
}

it('previews and drops the whole tool group on both sides and leaves it full if canceled', async () => {
  const { inside, mode, workspace, chat, tool } = await mountWorkspace();
  await userEvent.click(page.getByRole('button', { name: '打开测试工具' }));
  await mode('split');
  await act(() => { workspace.open('tool', { id: 'another' }, { from: null, intent: 'newTab' }); });
  const before = workspace.chatWorkspacePanes!.tools!.pane.tabOrder.slice();

  for (const [side, targetX, shouldCancel] of [['left', 90, false], ['right', 710, false], ['left', 90, true]] as const) {
    await userEvent.click(page.getByRole('button', { name: '进入完整视图' }));
    await until(`full view is ready for the ${side} drag (cancel: ${shouldCancel})`, () => workspace.chatWorkspaceMode === 'full');
    const byId = side === 'left' ? before[0] : before[1];
    const chip = inside(`[data-chat-workspace-header] [data-tabid="${byId}"]`)!;
    const box = chip.getBoundingClientRect();
    const startX = box.left + 20;
    const startY = box.top + box.height / 2;
    await mouse('mouseMoved', startX, startY);
    await mouse('mousePressed', startX, startY, true);
    await mouse('mouseMoved', startX, startY + 18, true);
    await until('the tab keeps a drag position in the toolbar', () => !!inside('[data-tab-dragging]'));
    await mouse('mouseMoved', targetX, 144, true);
    await until(`the ${side} group landing is previewed`, () => !!inside(`[data-chat-tool-drop-preview="${side}"]`));
    expect(workspace.chatWorkspaceMode).toBe('full');
    if (shouldCancel) {
      await userEvent.keyboard('{Escape}');
      await until('cancel clears the active tab drag and group landing preview', () => !inside('[data-tab-dragging]') && !inside('[data-chat-tool-drop-preview]'));
      await mouse('mouseReleased', targetX, 144);
      await mode('full');
      continue;
    }
    await mouse('mouseReleased', targetX, 144);
    await mode('split');
    const left = (el: HTMLElement | null) => el?.getBoundingClientRect().left ?? 0;
    await until(`both panes occupy their ${side} drop positions`, () => side === 'left' ? left(tool()) < left(chat()) : left(tool()) > left(chat()));
    expect(workspace.chatToolSide).toBe(side);
    expect(workspace.chatWorkspacePanes!.tools!.pane.tabOrder).toEqual(before);
    expect(workspace.chatWorkspacePanes!.tools!.pane.resolvedActiveTabId).toBe(byId);
    await until('the tab overlay finishes landing', () => !inside('[data-tab-dragging]') && !inside('.cursor-grabbing'));
  }
  expect(document.documentElement.hasAttribute('data-gugu-dragging')).toBe(false);
});

it('moves the tool group from the tab menu and still lets two tools pair', async () => {
  const { mode, workspace, inside } = await mountWorkspace();
  await userEvent.click(page.getByRole('button', { name: '打开测试工具' }));
  await mode('split');
  await act(() => { workspace.open('tool', { id: 'another' }, { from: null, intent: 'newTab' }); });
  const [first, second] = workspace.chatWorkspacePanes!.tools!.pane.tabOrder;
  const tab = (id: string) => page.elementLocator(inside(`[data-chat-workspace-header] [data-tabid="${id}"]`)!);
  await userEvent.click(tab(first), { button: 'right' });
  await userEvent.click(page.getByRole('menuitem', { name: '移至左侧面板' }));
  await until('the menu moves the whole group to the left', () => workspace.chatToolSide === 'left');
  expect(workspace.chatWorkspacePanes!.tools!.pane.tabOrder).toEqual([first, second]);

  await userEvent.click(tab(second), { button: 'right' });
  await userEvent.click(page.getByRole('menuitem', { name: /^(?:向右分|Split right)/ }));
  await until('the legacy two-tool strip appears', () => !!inside('[data-pane-strip]'));
  expect(new Set([workspace.pair?.pinned, workspace.pair?.side])).toEqual(new Set([first, second]));
});

it('resizes and previews each collapse before release, and restores the split on cancellation', async () => {
  const { inside, mode, width, chat, workspace } = await mountWorkspace();
  await userEvent.click(page.getByRole('button', { name: '打开测试工具' }));
  await mode('split');
  const separator = () => inside('[data-chat-tool-divider]')!.getBoundingClientRect();
  // The tool slides in on the track: grab the divider where it lands.
  await untilStable('the split comes to rest', () => separator().left);
  const begin = async () => {
    const rect = separator();
    const x = rect.left + rect.width / 2;
    const y = rect.top + 96;
    await mouse('mouseMoved', x, y);
    await mouse('mousePressed', x, y, true);
    return y;
  };

  const y = await begin();
  await mouse('mouseMoved', 443, y, true);
  await mouse('mouseReleased', 443, y);
  await until('the chat grows visibly as the divider moves', () => width(chat()), (w) => w > 435);
  const before = workspace.paneSizes.slice();

  await begin();
  await mouse('mouseMoved', 91, y, true);
  await until('the chat edge is previewed before release', () => !!inside('[data-chat-tool-collapse-preview="left"]'));
  await mode('split');
  await userEvent.keyboard('{Escape}');
  await until('cancel restores the pre-drag split', () => workspace.paneSizes[0], (share) => share === before[0]);
  await mouse('mouseReleased', 91, y);
  await mode('split');
  expect(inside('[data-chat-tool-collapse-preview]')).toBeNull();

  await begin();
  // Just past the chat's minimum (324): the fold is previewed at once, ❌ only near the block's edge.
  await mouse('mouseMoved', 300, y, true);
  await until('the approach previews a collapse without arming it', () => !!inside('[data-chat-tool-collapse-preview="left"]:not([data-chat-tool-collapse-ready])'));
  await mouse('mouseReleased', 300, y);
  await mode('split');
  expect(workspace.paneSizes[0]).toBeCloseTo(324 / 799 * 100);

  await begin();
  await mouse('mouseMoved', 91, y, true);
  await until('moving past the commit threshold arms the collapse', () => !!inside('[data-chat-tool-collapse-ready]'));
  await mouse('mouseReleased', 91, y);
  await mode('full');
  expect(workspace.paneSizes[0]).toBeCloseTo(324 / 799 * 100);
  await userEvent.click(page.getByRole('button', { name: '退出全屏' }));
  await mode('split');
  // Side by side the conversation is a card that gives its half of the 10px gutter (5px) out of its share.
  await until('restoring yields the last usable chat width', () => width(chat()), (w) => Math.abs(w - (324 - 5)) < 2);

  await begin();
  await mouse('mouseMoved', 749, y, true);
  await until('the tool edge is previewed before release', () => !!inside('[data-chat-tool-collapse-preview="right"]'));
  await mode('split');
  await mouse('mouseReleased', 749, y);
  await mode('hidden');
  await userEvent.click(page.getByRole('button', { name: '显示标签页' }));
  await mode('split');
  // (The conversation card is 5px inside its share: half the 10px gutter.)
  await until('restoring yields the last usable tool width', () => width(chat()), (w) => Math.abs(w - (475 - 5)) < 2);
  expect(document.documentElement.hasAttribute('data-gugu-dragging')).toBe(false);
});

it('restores the conversation width after dragging it into a tab and closing every tool tab', async () => {
  const { inside, mode, width, chat, workspace } = await mountWorkspace();
  const conversation = chat();
  await act(() => {
    for (let index = 0; index < 3; index += 1) workspace.open('tool', { id: `file-${index}` }, { from: null, intent: 'newTab' });
  });
  await mode('split');
  await untilStable('the split divider comes to rest', () => inside('[data-chat-tool-divider]')!.getBoundingClientRect().left);
  const divider = inside('[data-chat-tool-divider]')!.getBoundingClientRect();
  const x = divider.left + divider.width / 2;
  const y = divider.top + 96;
  await mouse('mouseMoved', x, y);
  await mouse('mousePressed', x, y, true);
  await mouse('mouseMoved', 91, y, true);
  await until('the conversation collapse is armed', () => !!inside('[data-chat-tool-collapse-ready]'));
  await mouse('mouseReleased', 91, y);
  await mode('full');
  await until('the conversation has collapsed into its tab', () => width(chat()), (size) => size === 0);

  for (let remaining = 2; remaining >= 0; remaining -= 1) {
    await userEvent.click(page.getByRole('button', { name: /^(?:关闭工具页签标签|Close 工具页签 tab)$/ }).first());
    await until('the closed tool leaves the strip', () => workspace.stripTabIds.length, (count) => count === remaining + 1);
  }
  await mode('empty');
  await untilStable('the remaining conversation settles', () => width(chat()));
  expect(chat(), 'the conversation is retained through the role change').toBe(conversation);
  expect(width(chat()), 'the sole conversation fills its block').toBe(800);
});

it('puts the view toggle on the header in the frame the tools are hidden, while they are still going off', async () => {
  const { inside, mode, workspace } = await mountWorkspace();
  await mode('empty');
  workspace.open('tool', { id: 'file' }, { from: null, intent: 'newTab' });
  await mode('split');
  await untilStable('the tools have landed', () => inside('[data-chat-tool-strip]')?.getBoundingClientRect().left);
  const onHeader = () => {
    const header = inside('[data-chat-workspace-header]')!.getBoundingClientRect();
    return [...inside('[data-chat-workspace-header]')!.querySelectorAll('button[aria-pressed]')].some((button) => {
      const box = button.getBoundingClientRect();
      return !button.closest('[data-chat-tool-strip]') && box.width > 0 && box.right <= header.right + 0.5;
    });
  };
  workspace.setChatToolLayout('hidden');
  // The first animation frame after hiding, before the tools' track lands: no gap without the toggle.
  await new Promise((frame) => requestAnimationFrame(frame));
  expect(onHeader(), 'the toggle left with the tools and came back only after they landed').toBe(true);
});

it('keeps the view toggle where it lands from the first frame the tools are hidden until they are off the track', async () => {
  const { inside, mode, workspace } = await mountWorkspace();
  await mode('empty');
  workspace.open('tool', { id: 'file' }, { from: null, intent: 'newTab' });
  await mode('split');
  await untilStable('the tools have landed', () => inside('[data-chat-tool-strip]')?.getBoundingClientRect().left);
  const header = inside('[data-chat-workspace-header]')!;
  const toggle = () => {
    const box = header.querySelector('button[aria-pressed]')!.getBoundingClientRect();
    return `${box.x},${box.y}`;
  };
  workspace.setChatToolLayout('hidden');
  const frames: string[] = [];
  // Every frame while the tools go off (the two cards stay until they land), then the first frame after.
  do {
    await new Promise((frame) => requestAnimationFrame(frame));
    frames.push(toggle());
  } while (header.hasAttribute('data-chat-tool-cards'));
  expect(frames.length, 'the tools went off over several frames').toBeGreaterThan(2);
  expect(new Set(frames), 'the toggle moved while the tools went off').toEqual(new Set([frames.at(-1)]));
});

it('draws the tools\' tabs at their measured density from the first frame they are shown', async () => {
  const { inside, mode, workspace } = await mountWorkspace();
  await mode('empty');
  for (const id of ['a', 'b', 'c']) workspace.open('tool', { id }, { from: null, intent: 'newTab' });
  await mode('split');
  await untilStable('the tools have landed', () => inside('[data-chat-tool-strip]')?.getBoundingClientRect().left);
  const densities = () => [...inside('[data-chat-tool-strip]')?.querySelectorAll<HTMLElement>('[data-tab-density]') ?? []].map((tab) => tab.dataset.tabDensity);
  const atRest = densities();
  expect(atRest, 'three tools in the split are narrow enough to draw compact').toContain('compact');
  workspace.setChatToolLayout('hidden');
  await until('the tools are off the track', () => !inside('[data-chat-tool-strip]'));
  workspace.setChatToolLayout('split');
  await new Promise((frame) => requestAnimationFrame(frame));
  expect(densities(), 'the first frame drew the tabs before their width was measured').toEqual(atRest);
});

it('keeps the tools\' strip on their card while it narrows, ❌ its + and buttons past the card until it lands', async () => {
  const { inside, mode, workspace } = await mountWorkspace();
  await mode('empty');
  for (const id of ['a', 'b']) workspace.open('tool', { id }, { from: null, intent: 'newTab' });
  await mode('split');
  await untilStable('the tools have landed', () => inside('[data-chat-tool-strip]')?.getBoundingClientRect().left);
  const strip = () => inside('[data-chat-tool-strip]')!.getBoundingClientRect();
  const card = () => inside('[data-chat-tool-card]')!.getBoundingClientRect();
  const toggle = () => inside('[data-chat-tool-strip] button[aria-pressed]')!.getBoundingClientRect();
  const overhang = () => Math.round(strip().right - card().right);
  const atRest = overhang();
  await act(() => { if (workspace.layout.type === 'split') workspace.setSplitSizes(workspace.layout.id, [70, 30]); });
  const lefts = new Set<number>();
  const frames: string[] = [];
  for (let frame = 0; frame < 30; frame += 1) {
    await new Promise((next) => requestAnimationFrame(next));
    lefts.add(Math.round(card().left));
    frames.push(`overhang=${overhang()} toggleIn=${toggle().right <= card().right + 1}`);
  }
  expect(lefts.size, 'the tools narrowed over several frames').toBeGreaterThan(2);
  expect(new Set(frames), 'the strip left its card while the tools narrowed').toEqual(new Set([`overhang=${atRest} toggleIn=true`]));
});
