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
  const drag = useTabDrag({ layout, blockId: null, contentOf: () => null, openWindow: () => null });
  return <PaneLayoutProvider paneLayout={layout}>
    <DndContext sensors={drag.sensors} collisionDetection={edgeFirst} onDragStart={drag.onDragStart} onDragMove={drag.onDragMove} onDragEnd={drag.onDragEnd} onDragCancel={drag.onDragCancel}>
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
  await act(() => view.render(<WorkspaceDrag layout={workspace}>
    <div style={{ width: 800, height: '100%' }} data-chat-workspace-test-main="">
      <PaneTreeView layout={workspace} chatChrome={{
        actions: <TabBarActionRow atWindowEdge={false}><span>聊天操作</span></TabBarActionRow>,
        addTab: <Button size="icon-sm" variant="ghost" aria-label="打开测试工具" onClick={() => workspace.open('tool', { id: 'file' }, { from: null, intent: 'newTab' })}><Plus className="size-3.5" /></Button>,
      }} renderPane={(paneId, _first, _last, part) => {
        const group = workspace.groups.find((pane) => pane.paneId === paneId)!;
        return <PaneProvider group={group} isFocusedPane={group === workspace.groups.find((candidate) => candidate.paneId === workspace.activePaneId)}><PaneContent part={part} /></PaneProvider>;
      }} />
    </div>
    <aside style={{ width: 380, height: '100%' }} data-chat-workspace-test-neighbour="">另一条聊天</aside>
  </WorkspaceDrag>));
  const inside = (selector: string) => view.container.querySelector<HTMLElement>(selector);
  const width = (element: HTMLElement | null | undefined) => element?.getBoundingClientRect().width ?? 0;
  const mode = (value: string) => until(`shows the ${value} chat header`, () => !!inside(`[data-chat-workspace-header="${value}"]`));
  const chat = () => inside('[data-chat-workspace-test-body="conversation"]');
  const tool = () => inside('[data-chat-workspace-test-body="tool"]');
  const neighbour = () => inside('[data-chat-workspace-test-neighbour]')!;
  return { inside, width, mode, chat, tool, neighbour, workspace, openWindow };
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
  expect(inside('[data-chat-workspace-header]')?.getBoundingClientRect().height).toBe(44);
  expect(inside('[data-chat-workspace-header] [data-tab-label]')).toBeNull();
  expect(tool()).toBeNull();
  expect(page.getByRole('button', { name: '单独成窗' }).query()).toBeNull();
  await userEvent.click(page.getByRole('button', { name: /^(?:More|更多)$/ }));
  await userEvent.click(page.getByRole('menuitem', { name: '单独成窗' }));
  expect(openWindow).toHaveBeenCalledOnce();
  await userEvent.click(page.getByRole('button', { name: '打开测试工具' }));
  await mode('split');
  await until('the split produces two measurable pages', () => width(chat()) > 0 && width(tool()) > 0 && width(tool()) < 800);
  // The tool slides in on the track: the split width to restore is the one it lands on.
  await untilStable('the split comes to rest', () => width(chat()));
  const chip = inside('[data-chat-workspace-header] [data-tab-label="工具页签"]')!;
  const hideButton = inside('button[aria-label="隐藏标签页"]')!;
  expect(chip.getBoundingClientRect().height).toBe(32);
  expect(getComputedStyle(chip).borderBottomLeftRadius).toBe('8px');
  expect(hideButton.getBoundingClientRect()).toMatchObject({ width: 28, height: 28, y: 8 });
  expect(getComputedStyle(hideButton).borderRadius).toBe('8px');
  expect(hideButton.getAttribute('aria-pressed')).toBe('true');
  const panelIcon = hideButton.querySelector('svg')?.innerHTML;
  expect(panelIcon).toBeTruthy();
  const firstTool = tool();
  const chatWidth = width(chat());

  await userEvent.click(page.getByRole('button', { name: '隐藏标签页' }));
  // The tool itself goes out on the track — live, in reach of nothing, ❌ blank at once or a picture of it — and the chat
  // beside it is laid out at every width it is drawn at.
  const toolLefts: number[] = [];
  const chatWidths = new Set<number>();
  for (let frame = 0; frame < 40; frame += 1) {
    await new Promise(requestAnimationFrame);
    const shown = firstTool && !firstTool.closest('[inert]') && firstTool.getBoundingClientRect().width > 0;
    toolLefts.push(shown ? Math.round(firstTool.getBoundingClientRect().left) : -1);
    chatWidths.add(Math.round(width(chat())));
  }
  expect(toolLefts[0], toolLefts.join(' ')).toBeGreaterThan(0);
  expect(new Set(toolLefts.filter((left) => left >= 0)).size, toolLefts.join(' ')).toBeGreaterThan(5);
  expect(chatWidths.size, [...chatWidths].join(' ')).toBeGreaterThan(5);
  await mode('hidden');
  const showButton = inside('button[aria-label="显示标签页"]')!;
  expect(showButton.getAttribute('aria-pressed')).toBe('false');
  expect(showButton.querySelector('svg')?.innerHTML).toBe(panelIcon);
  expect(showButton.getBoundingClientRect()).toMatchObject({ width: 28, height: 28, y: 8 });
  expect(getComputedStyle(showButton).borderRadius).toBe('8px');
  await until('the chat uses the full width of its own block', () => width(chat()), (size) => size === 800);
  // The tool goes out on the track and is out of reach once it lands.
  await until('the hidden tool is out of reach', () => !!firstTool?.closest('[inert]'));
  await userEvent.click(page.getByRole('button', { name: '显示标签页' }));
  await mode('split');
  // Shown again, the tool comes in on the track like a new one, ❌ in one frame.
  const shownLefts = new Set<number>();
  for (let frame = 0; frame < 20; frame += 1) {
    await new Promise(requestAnimationFrame);
    shownLefts.add(Math.round(tool()?.getBoundingClientRect().left ?? -1));
  }
  expect(shownLefts.size, [...shownLefts].join(' ')).toBeGreaterThan(5);
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
  const { inside, mode, workspace } = await mountWorkspace();
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
  await mouse('mouseMoved', 173, y, true);
  await until('the approach previews a collapse without arming it', () => !!inside('[data-chat-tool-collapse-preview="left"]:not([data-chat-tool-collapse-ready])'));
  await mouse('mouseReleased', 173, y);
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
  await until('restoring yields the last usable chat width', () => width(chat()), (w) => Math.abs(w - 324) < 2);

  await begin();
  await mouse('mouseMoved', 749, y, true);
  await until('the tool edge is previewed before release', () => !!inside('[data-chat-tool-collapse-preview="right"]'));
  await mode('split');
  await mouse('mouseReleased', 749, y);
  await mode('hidden');
  await userEvent.click(page.getByRole('button', { name: '显示标签页' }));
  await mode('split');
  await until('restoring yields the last usable tool width', () => width(chat()), (w) => Math.abs(w - 475) < 2);
  expect(document.documentElement.hasAttribute('data-gugu-dragging')).toBe(false);
});
