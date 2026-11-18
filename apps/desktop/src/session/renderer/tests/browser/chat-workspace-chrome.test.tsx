import { DndContext } from '@dnd-kit/core';
import { act } from 'react';
import { afterEach, expect, it } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { createReactHarness } from '../../../../../../../tests/support/testHarness';
import { until } from '../../../../../../../tests/support/awaitCondition';
import { createTabProvider, createTabRegistry } from '@renderer/features/tabs/core/tab-provider-registry';
import { PaneLayoutStore } from '@renderer/features/tabs/pane-layout-store';
import { PaneTreeView } from '@renderer/features/tabs/pane-tree-view';
import { PaneContent } from '@renderer/features/tabs/pane-content';
import { PaneProvider } from '@renderer/features/tabs/pane-context';
import { Button } from '@renderer/lib/ui/button';
import { Plus } from '@/lib/icons';
import { TabBarActionRow } from '@renderer/features/sessions/titlebar-actions';
import { GenericTabItem } from '@renderer/features/tabs/tab-bar/generic-tab-item';
import '@renderer/index.css';
import '@/styles/tokens.css';

const provider = (kind: string) => createTabProvider({
  kind,
  conversation: kind === 'conversation',
  resourceKey: (state: { id: string }) => state.id,
  initialize: () => ({ dispose() {} }),
  dispose() {},
  TabContent: () => <div data-chat-workspace-test-body={kind}>{kind === 'conversation' ? '聊天正文' : '工具正文'}</div>,
  TabBarItem: ({ tab, host, ctx }) => <GenericTabItem tab={tab} host={host} ctx={ctx} label={kind === 'conversation' ? '聊天标题' : '工具页签'} />,
  TabBarItemDragPreview: () => null,
});

let harness: ReturnType<typeof createReactHarness> | undefined;
let layout: PaneLayoutStore | undefined;
afterEach(() => { harness?.cleanup(); layout?.dispose(); harness = undefined; layout = undefined; });

it('opens the first tool into a split, hides/restores it and expands only its own block', async () => {
  await page.viewport(1220, 790);
  const view = harness = createReactHarness();
  view.container.classList.add('emlight', 'gugu-skin');
  view.container.style.cssText = 'position:fixed;left:0;top:0;width:1180px;height:580px;display:flex';
  const workspace = layout = new PaneLayoutStore(createTabRegistry(['conversation', 'tool'].map(provider)), { viewId: 'chat-workspace-browser-test' }, undefined, {
    isPrimaryChatTab: (entry) => entry.kind === 'conversation',
    placementMemory: { read: () => undefined, write() {} },
  });
  workspace.open('conversation', { id: 'chat' }, { from: null, intent: 'newTab' });
  workspace.setViewActive(true);
  await act(() => view.render(<DndContext>
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
  </DndContext>));
  const inside = (selector: string) => view.container.querySelector<HTMLElement>(selector);
  const width = (element: HTMLElement | null | undefined) => element?.getBoundingClientRect().width ?? 0;
  const mode = (value: string) => until(`shows the ${value} chat header`, () => !!inside(`[data-chat-workspace-header="${value}"]`));
  const chat = () => inside('[data-chat-workspace-test-body="conversation"]');
  const tool = () => inside('[data-chat-workspace-test-body="tool"]');
  const neighbour = () => inside('[data-chat-workspace-test-neighbour]')!;
  const neighbourBefore = neighbour().getBoundingClientRect().toJSON();

  await mode('empty');
  expect(inside('[data-chat-workspace-title]')?.textContent).toContain('聊天标题');
  expect(inside('[data-chat-workspace-header]')?.getBoundingClientRect().height).toBe(44);
  expect(inside('[data-chat-workspace-header] [data-tab-label]')).toBeNull();
  expect(tool()).toBeNull();
  await userEvent.click(page.getByRole('button', { name: '打开测试工具' }));
  await mode('split');
  await until('the split produces two measurable pages', () => width(chat()) > 0 && width(tool()) > 0 && width(tool()) < 800);
  const chip = inside('[data-chat-workspace-header] [data-tab-label="工具页签"]')!;
  const hideButton = inside('button[aria-label="隐藏标签页"]')!;
  expect(chip.getBoundingClientRect().height).toBe(32);
  expect(getComputedStyle(chip).borderBottomLeftRadius).toBe('8px');
  expect(hideButton.getBoundingClientRect()).toMatchObject({ width: 28, height: 28, y: 8 });
  const firstTool = tool();
  const chatWidth = width(chat());

  await userEvent.click(page.getByRole('button', { name: '隐藏标签页' }));
  await mode('hidden');
  await until('the chat uses the full width of its own block', () => width(chat()), (size) => size === 800);
  expect(firstTool?.closest('[inert]')).not.toBeNull();
  await userEvent.click(page.getByRole('button', { name: '显示标签页' }));
  await mode('split');
  await until('the original split width is restored', () => width(chat()), (size) => size === chatWidth);

  await userEvent.click(page.getByRole('button', { name: '进入完整视图' }));
  await mode('full');
  await until('the tool fills the chat block', () => width(tool()), (size) => size === 800);
  expect(tool()).toBe(firstTool);
  expect(chat()?.closest('[inert]')).not.toBeNull();
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
  expect(tool()).toBeNull();
});
