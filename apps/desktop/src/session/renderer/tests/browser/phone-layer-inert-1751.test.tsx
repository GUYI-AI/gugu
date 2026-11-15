import { afterEach, beforeEach, expect, it } from 'vitest';
import { cdp, page } from 'vitest/browser';
import { act, useState } from 'react';
import type { SidebarTab } from '@gugu/core/shared/enums/sidebarTabModels';
import { MobileTabPager } from '@/mobile/MobileTabPager';
import { PhoneLayer } from '@/mobile/PhoneLayer';
import { createReactHarness } from '../../../../../../../tests/support/testHarness';
import { until } from '../../../../../../../tests/support/awaitCondition';
import '@/styles/tokens.css';
import '@/mobile/phone-shell.css';

// #1751 手机上拖选区手柄,文字跳:藏着的 PhoneLayer(咕咕 / 项目会话 / 我的)只套了 RETAINED_SURFACE_HIDDEN_STYLE,
// 根 DIV 自己仍可选,Chromium 拖动时把它的 offset 0 当成落点 —— 真机 102 条采样 19 条落在 mobile-settings-layer。
// 现在 PhoneLayer 按 open 绑原生 inert:藏着的整层(根与后代)不参与选区、焦点与点击;打开时解除,DOM / 草稿 / 滚动原样。
// 这里断言的是确定性的事实(整层 inert、后代拿不到焦点、不在无障碍树里)。原问题走的是手机原生选区手柄,
// headless 桌面鼠标拖选复现不出越界端点,所以这里不写拖选端点断言;C2 手势三次 0 越界由真机复测。

const LAYERS = [
  { tab: 'assistant', testId: 'mobile-assistant-layer' },
  { tab: 'tasks', testId: 'mobile-sessions-layer' },
  { tab: 'settings', testId: 'mobile-settings-layer' },
] as const;
const ROOT_TABS: readonly SidebarTab[] = ['chats', 'contacts'];
const LONG = Array.from({ length: 6 }, (_, i) => `Line ${i + 1} of the harbor story, long enough to wrap twice on a phone screen.`).join(' ');

let harness: ReturnType<typeof createReactHarness>;
let setTab: (tab: SidebarTab) => void = () => {};
beforeEach(() => page.viewport(390, 844));
afterEach(() => { harness?.cleanup(); document.getSelection()?.removeAllRanges(); });

function Shell() {
  const [activeTab, setActiveTab] = useState<SidebarTab>('chats');
  setTab = setActiveTab;
  const layerOpen = !ROOT_TABS.includes(activeTab);
  return (
    <div data-phone-shell="" style={{ position: 'relative', width: 390, height: 844, display: 'flex', flexDirection: 'column' }}>
      <MobileTabPager
        mobile
        tabs={ROOT_TABS}
        activeTab={layerOpen ? 'chats' : activeTab}
        covered={layerOpen}
        swipeable={!layerOpen}
        onSettle={() => {}}
        tabBarRef={{ current: null }}
        pages={{
          chats: <p data-testid="root-text" style={{ margin: '120px 24px 0', font: '16px/1.6 sans-serif' }}>{LONG}</p>,
          contacts: <p>Contacts</p>,
        }}
      />
      {LAYERS.map(({ tab, testId }) => (
        <PhoneLayer key={tab} open={activeTab === tab} testId={testId}>
          <p data-testid={`${tab}-text`} style={{ margin: '120px 24px 0', font: '16px/1.6 sans-serif' }}>{`${tab} layer: ${LONG}`}</p>
          <textarea data-testid={`${tab}-draft`} defaultValue="" />
          <div data-testid={`${tab}-scroll`} style={{ height: 80, overflow: 'auto' }}><div style={{ height: 1000 }}>scroll</div></div>
          <button type="button">{`${tab} action`}</button>
        </PhoneLayer>
      ))}
    </div>
  );
}

const layer = (testId: string) => document.querySelector<HTMLElement>(`[data-testid="${testId}"]`)!;
const rootPage = () => document.querySelector<HTMLElement>('[data-mobile-tab-page="chats"]')!;
const hiddenLayers = () => LAYERS.map(({ testId }) => layer(testId)).filter((el) => !el.hasAttribute('data-open'));

async function mount() {
  harness = createReactHarness();
  await harness.render(<Shell />);
}

it('makes every hidden phone layer inert as a whole and leaves the home pager live', async () => {
  await mount();
  for (const el of hiddenLayers()) {
    expect(el.inert).toBe(true);
    // 整层:根自己和每个后代都在 inert 子树里(❌ 只给后代补 user-select)。
    for (const node of [el, ...el.querySelectorAll('*')]) expect(node.closest('[inert]')).toBe(el);
    const button = el.querySelector('button')!;
    button.focus();
    expect(document.activeElement).not.toBe(button);
  }
  expect(hiddenLayers()).toHaveLength(3);
  expect(rootPage().inert).toBe(false);
});

it('opening one layer releases only that layer; the other two and the covered pager stay inert', async () => {
  await mount();
  for (const { tab, testId } of LAYERS) {
    await act(async () => setTab(tab));
    expect(layer(testId).inert).toBe(false);
    expect(layer(testId).hasAttribute('data-open')).toBe(true);
    const button = layer(testId).querySelector('button')!;
    button.focus();
    expect(document.activeElement).toBe(button);
    button.blur();
    for (const other of LAYERS.filter((entry) => entry.tab !== tab)) expect(layer(other.testId).inert).toBe(true);
    expect(rootPage().inert).toBe(true);
  }
  await act(async () => setTab('chats'));
  expect(hiddenLayers()).toHaveLength(3);
  expect(rootPage().inert).toBe(false);
});

it('keeps the same DOM, draft and scroll position across close and reopen', async () => {
  await mount();
  await act(async () => setTab('settings'));
  const draft = layer('settings-draft') as HTMLTextAreaElement;
  const scroller = layer('settings-scroll');
  draft.value = 'half-written reply';
  scroller.scrollTop = 300;
  await act(async () => setTab('chats'));
  expect(layer('mobile-settings-layer').inert).toBe(true);
  await act(async () => setTab('settings'));
  expect(layer('settings-draft')).toBe(draft);
  expect(draft.value).toBe('half-written reply');
  expect(layer('settings-scroll')).toBe(scroller);
  expect(scroller.scrollTop).toBe(300);
});

it('keeps hidden layers out of the accessibility tree and the open layer in it', async () => {
  await mount();
  await act(async () => setTab('tasks'));
  type AXNode = { ignored?: boolean; role?: { value?: string }; name?: { value?: string } };
  type FrameTree = { frame: { id: string }; childFrames?: FrameTree[] };
  const { frameTree } = await cdp().send('Page.getFrameTree') as { frameTree: FrameTree };
  const frames: string[] = [];
  const walk = (tree: FrameTree) => { frames.push(tree.frame.id); tree.childFrames?.forEach(walk); };
  walk(frameTree);
  const nodes: AXNode[] = [];
  for (const frameId of frames) nodes.push(...(await cdp().send('Accessibility.getFullAXTree', { frameId }) as { nodes: AXNode[] }).nodes);
  const named = (label: string) => nodes.filter((node) => !node.ignored && node.role?.value === 'button' && node.name?.value === label);
  expect(named('tasks action')).toHaveLength(1);
  expect(named('settings action')).toHaveLength(0);
  expect(named('assistant action')).toHaveLength(0);
});

it('takes focus out of a layer when it closes and lets the reopened layer take it again', async () => {
  await mount();
  await act(async () => setTab('assistant'));
  const draft = layer('assistant-draft');
  draft.focus();
  expect(document.activeElement).toBe(draft);
  await act(async () => setTab('chats'));
  await until('focus leaves the closed layer', () => !layer('mobile-assistant-layer').contains(document.activeElement));
  draft.focus();
  expect(document.activeElement).not.toBe(draft);
  await act(async () => setTab('assistant'));
  draft.focus();
  expect(document.activeElement).toBe(draft);
});
