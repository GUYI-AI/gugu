import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { BlockGrip, ScreenFrame, screenDropHandlers, startSessionBlockDrag } from '@renderer/app/screen-frame';
import { blockDropPreview, resolveBlockDrop, setBlockDropPreview } from '@renderer/app/screen-layout-actions';
import { clearDraggedScreenContent, hasDraggedScreenContent, setDraggedScreenContent } from '@renderer/lib/drag-screen-content';
import { shieldNativeDrags } from '@renderer/lib/drag-shield';
import { DropHighlightLayer } from '@renderer/lib/drop-highlight';
import { screenLayout } from '@renderer/app/screen-layout';
import { groupParticipantPanes } from '@renderer/features/chats/group-participant-panes';
import '@/styles/tokens.css';
import '@renderer/index.css';
import { drainTopicSplitRequest } from '@/lib/topicSplitRequest';
import { until } from '../../../../../../../tests/support/awaitCondition';
import { WorkspaceLayoutContextProvider } from '@renderer/lib/layout/layout-provider';

// #7052 一屏几块:真组件(ScreenFrame 的 TrackCut)、真几何。判据钉的是 2026-10-09 实机撞过的几件:
//  · 块与块之间一根 1px 线,和会话列表右边那根同色(owner「怎么会没有任何分割线」→「这么粗的线…不能统一吗」);
//  · 会话页是贴在块上的另一层,压在线两边:线两边那几 px 照样抓得到;
//  · 一列塌成一块(占一块的 App 被收走)之后,剩下的块各得一半,❌ 新挂上的那块只拿到 1%(实测挤成 19px);
//  · 块不够两半(一格最窄 220px)时拖到边上不给落点;正中不接。

let root: Root | null = null;
let host: HTMLDivElement | null = null;
const s = (sessionId: string) => ({ projectId: 'p', sessionId });

beforeEach(async () => {
  vi.stubGlobal('electronAPI', { invoke: async (channel: string) => { if (channel !== 'viewState.save') throw new Error(`unexpected IPC: ${channel}`); }, eventOn: () => () => {} });
  await page.viewport(1200, 700);
  document.body.style.margin = '0';
  host = document.createElement('div');
  host.className = 'gugu-skin';
  host.style.cssText = 'position:relative;display:flex;width:1000px;height:500px';
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  root?.unmount();
  host?.remove();
  root = null;
  host = null;
  for (const block of [...screenLayout.blocks.values(), ...screenLayout.parkedContents]) screenLayout.forgetContent(block);
  clearDraggedScreenContent();
  setBlockDropPreview(null);
});

const nextFrames = async (count: number) => {
  for (let i = 0; i < count; i++) await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
};
const blockWidths = () =>
  [...document.querySelectorAll<HTMLElement>('[data-screen-block]')].map((el) => Math.round(el.getBoundingClientRect().width));
const separator = () => document.querySelector<HTMLElement>('[data-screen-frame] [data-slot="resizable-handle"]');

describe('一屏几块的骨架 (#7052)', () => {
  it.each([
    ['left', 0.3, 0.4], ['right', 0.7, 0.4], ['top', 0.4, 0.3], ['bottom', 0.6, 0.7],
  ] as const)('previews and splits a task dropped in the chat centre nearest its %s edge', async (edge, x, y) => {
    screenLayout.show({ kind: 'chat', chatId: 'chat-centre' });
    root!.render(<WorkspaceLayoutContextProvider><ScreenFrame /><DropHighlightLayer /></WorkspaceLayoutContextProvider>);
    await until('chat block rendered', () => blockWidths().length === 1);
    const blockId = screenLayout.order[0];
    const block = host!.querySelector<HTMLElement>('[data-screen-block]')!;
    const rect = block.getBoundingClientRect();
    const dataTransfer = new DataTransfer();
    setDraggedScreenContent(dataTransfer, { kind: 'session', ...s('incoming'), title: 'Incoming' });
    const handlers = screenDropHandlers(true);
    const event = { dataTransfer, target: block, clientX: rect.left + rect.width * x, clientY: rect.top + rect.height * y, preventDefault: vi.fn(), stopPropagation: vi.fn() };
    handlers.onDragOverCapture(event as never);
    expect(blockDropPreview.get()).toEqual({ blockId, edge });
    // The shared drop highlight springs onto the half that edge splits off (@@@drop-highlight).
    const half = { left: edge === 'right' ? rect.left + rect.width / 2 : rect.left, top: edge === 'bottom' ? rect.top + rect.height / 2 : rect.top, width: edge === 'left' || edge === 'right' ? rect.width / 2 : rect.width, height: edge === 'top' || edge === 'bottom' ? rect.height / 2 : rect.height };
    await until('split preview on that half', () => {
      const box = document.querySelector('[data-drop-highlight="shown"]')?.getBoundingClientRect();
      return !!box && (['left', 'top', 'width', 'height'] as const).every((key) => Math.abs(box[key] - half[key]) < 1);
    });
    handlers.onDropCapture(event as never);
    expect(screenLayout.order).toHaveLength(2);
    expect(screenLayout.blockOfSession('incoming')).toBeDefined();
    expect(blockDropPreview.get()).toBeNull();
  });

  it('leaves a chat composer drop to its own mention handler even near an edge', async () => {
    screenLayout.show({ kind: 'chat', chatId: 'chat-composer' });
    root!.render(<WorkspaceLayoutContextProvider><ScreenFrame /></WorkspaceLayoutContextProvider>);
    await until('chat block rendered', () => blockWidths().length === 1);
    const block = host!.querySelector<HTMLElement>('[data-screen-block]')!;
    const rect = block.getBoundingClientRect();
    const composer = document.createElement('div');
    composer.dataset.slot = 'composer-bar';
    block.appendChild(composer);
    const dataTransfer = new DataTransfer();
    setDraggedScreenContent(dataTransfer, { kind: 'session', ...s('incoming'), title: 'Incoming' });
    const event = { dataTransfer, target: composer, clientX: rect.left + 5, clientY: rect.bottom - 5, preventDefault: vi.fn(), stopPropagation: vi.fn() };
    const handlers = screenDropHandlers(true);
    handlers.onDragOverCapture(event as never);
    handlers.onDropCapture(event as never);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(blockDropPreview.get()).toBeNull();
    expect(screenLayout.order).toHaveLength(1);
    composer.remove();
  });

  it('opens a topic only after its source chat lands in a workspace split', async () => {
    screenLayout.show(s('a'));
    root!.render(<ScreenFrame />);
    await until('one block', () => blockWidths().length === 1);
    const rect = host!.querySelector('[data-screen-block]')!.getBoundingClientRect();
    const dataTransfer = new DataTransfer();
    setDraggedScreenContent(dataTransfer, { kind: 'chat', chatId: 'group', title: 'Topic', topic: { chatId: 'topic', name: 'Topic' } });
    const handlers = screenDropHandlers(true);
    const event = { dataTransfer, target: host, clientX: rect.left + 5, clientY: rect.top + rect.height / 2, preventDefault: vi.fn(), stopPropagation: vi.fn() };
    const composer = document.createElement('div');
    composer.dataset.slot = 'composer-bar';
    handlers.onDropCapture({ ...event, target: composer } as never);
    expect(drainTopicSplitRequest('group')).toBeNull();
    handlers.onDropCapture(event as never);
    expect(screenLayout.order).toHaveLength(2);
    expect(drainTopicSplitRequest('group')).toEqual({ chatId: 'topic', name: 'Topic', sourceChatId: 'group', focusComposer: true });
    screenLayout.close(screenLayout.order.find((id) => screenLayout.blocks.get(id)?.kind === 'chat')!);
    clearDraggedScreenContent();
  });

  it('can move an existing block beside its neighbour using the space its old block releases', async () => {
    host!.style.width = '800px';
    screenLayout.show(s('a'));
    screenLayout.showBeside(s('b'));
    root!.render(<ScreenFrame />);
    await until('two narrow blocks', () => blockWidths().length === 2 && blockWidths().every((w) => w > 390 && w < 410));
    const blockId = screenLayout.blockOfSession('b')!;
    const rect = document.querySelector<HTMLElement>(`[data-screen-block="${blockId}"]`)!.getBoundingClientRect();
    // Each current block is narrower than two 220px panes, but moving a releases its old 400px.
    expect(resolveBlockDrop(rect.right - 5, rect.top + rect.height / 2, { kind: 'session', ...s('a') })).toEqual({ blockId, edge: 'right' });
    // A new third block would really have to fit inside those 400px.
    expect(resolveBlockDrop(rect.right - 5, rect.top + rect.height / 2, { kind: 'session', ...s('c') })).toBeNull();
  });

  it('两块之间一根 1px 线,和别处的分界线(话题分栏、右栏)同一个 token;会话页压在两边时线两边那几 px 仍抓得到', async () => {
    screenLayout.show(s('a'));
    screenLayout.showBeside(s('b'));
    root!.render(<ScreenFrame />);
    await until('两块铺开', () => blockWidths().length === 2 && blockWidths().every((w) => w > 400));

    const line = separator()!;
    const rect = line.getBoundingClientRect();
    expect(Math.round(rect.width)).toBe(1);
    const reference = document.createElement('div');
    reference.className = 'bg-[var(--border-subtle)]';
    host!.appendChild(reference);
    expect(getComputedStyle(line).backgroundColor).toBe(getComputedStyle(reference).backgroundColor);
    reference.remove();

    // 会话页那一层:绝对定位、贴在每块上(同 anchoredToBlock),和线在同一个叠放层里。
    for (const block of document.querySelectorAll<HTMLElement>('[data-screen-block]')) {
      const box = block.getBoundingClientRect();
      const page = document.createElement('div');
      page.style.cssText = `position:absolute;left:${box.left}px;top:${box.top}px;width:${box.width}px;height:${box.height}px;background:white`;
      page.dataset.fakePage = '';
      host!.appendChild(page);
    }
    const x = rect.left + rect.width / 2;
    for (const dx of [-3, -2, 0, 2, 3]) {
      expect(document.elementFromPoint(x + dx, 250)?.closest('[data-slot="resizable-handle"]'), `x${dx >= 0 ? '+' : ''}${dx}`).toBe(line);
    }
  });

  it('一列塌成一块之后,两块各得一半(❌ 新挂上的那块只拿到 1%)', async () => {
    // 先摆好两块、画出来,再在右边那块下面分出一块 —— 那一刀是在分块那组已经挂好之后才长出来的(实机就是这个顺序;
    // 一开始就画三块复现不出来)。
    screenLayout.show(s('a'));
    screenLayout.showBeside(s('b'));
    root!.render(<ScreenFrame />);
    await until('两块铺开', () => blockWidths().length === 2 && blockWidths().every((w) => w > 400));
    screenLayout.placeAt({ kind: 'session', projectId: 'p', sessionId: 'c' }, screenLayout.blockOfSession('b')!, 'bottom');
    await until('三块铺开', () => blockWidths().length === 3);
    await nextFrames(5);

    screenLayout.forgetSession('c');
    await until('收成两块', () => blockWidths().length === 2);
    await nextFrames(10);
    // 不重挂时这里是 [979, 20]。
    expect(blockWidths().every((w) => Math.abs(w - 500) < 10), JSON.stringify(blockWidths())).toBe(true);
  });

  // 对话块的格子是壳画对话的落点(ChatSlotHost 的 portal):格子换了一个 div,整个对话跟着重建(落点、消息窗、每条 Markdown)。
  it('分出一块、再收回,留下的对话块还是同一个格子', async () => {
    screenLayout.show({ kind: 'chat', chatId: 'chat-stays' });
    root!.render(<WorkspaceLayoutContextProvider><ScreenFrame /></WorkspaceLayoutContextProvider>);
    await until('chat block rendered', () => blockWidths().length === 1);
    // 对话格子(ChatSlot)在这一块的占位里:占位重挂,格子跟着换。
    const blockId = screenLayout.order[0];
    const slot = () => document.querySelector(`[data-screen-block="${blockId}"]`);
    const original = slot();
    expect(original).not.toBeNull();
    // 存下来的是 screenLayout.snapshot(布局树和份额);份额只在人拖线时写(setSplitSizes),窗口宽窄夹出来的不写。
    const saved = JSON.stringify(screenLayout.snapshot);

    screenLayout.showBeside(s('b'));
    await until('两块铺开', () => blockWidths().length === 2 && blockWidths().every((w) => w > 400));
    expect(slot(), '1 → 2').toBe(original);
    screenLayout.placeAt({ kind: 'session', projectId: 'p', sessionId: 'c' }, screenLayout.blockOfSession('b')!, 'right');
    await until('三块铺开', () => blockWidths().length === 3);
    expect(slot(), '2 → 3').toBe(original);
    screenLayout.forgetSession('c');
    await until('收成两块', () => blockWidths().length === 2);
    expect(slot(), '3 → 2').toBe(original);
    screenLayout.forgetSession('b');
    await until('收成一块', () => blockWidths().length === 1);
    await nextFrames(5);
    expect(slot(), '2 → 1').toBe(original);
    expect(blockWidths()).toEqual([1000]);
    expect(JSON.stringify(screenLayout.snapshot), '1 → 2 → 1 存下来的一个字节不差').toBe(saved);
  });

  // 只有一块时是「一格的组」,不重挂:从群里点 agent 的名字,参与者在右边分出一块,同一组从 1 格变 2 格
  // (2026-10 曾在这一步整窗崩到 Something went wrong)。
  it('从单块打开群参与者:不抛错,右边那块按记住的宽度;收回又占满', async () => {
    const thrown: string[] = [];
    const onError = (event: ErrorEvent) => thrown.push(event.message);
    window.addEventListener('error', onError);
    try {
      groupParticipantPanes.useAccount('participant-from-sole');
      const source = { kind: 'chat', chatId: 'group-sole' } as const;
      screenLayout.show(source);
      root!.render(<WorkspaceLayoutContextProvider><ScreenFrame /></WorkspaceLayoutContextProvider>);
      await until('one block', () => blockWidths().length === 1);
      const extent = host!.querySelector<HTMLElement>('[data-screen-block]')!.getBoundingClientRect().width;
      expect(groupParticipantPanes.show('group-sole', source, { kind: 'session', ...s('agent') }, extent)).toBe(true);
      await until('two blocks, or the throw', () => thrown.length > 0 || blockWidths().length === 2);
      expect(thrown).toEqual([]);
      await nextFrames(5);
      expect(thrown).toEqual([]);
      const right = Math.round(document.querySelector<HTMLElement>(`[data-screen-block="${screenLayout.blockOfSession('agent')}"]`)!.getBoundingClientRect().width);
      expect(Math.abs(right - groupParticipantPanes.rightWidth), JSON.stringify(blockWidths())).toBeLessThan(3);
      groupParticipantPanes.hide('group-sole');
      await until('one block again', () => blockWidths().length === 1);
      await nextFrames(5);
      expect(thrown).toEqual([]);
      expect(blockWidths()).toEqual([1000]);
    } finally {
      window.removeEventListener('error', onError);
      groupParticipantPanes.useAccount(null);
    }
  });

  // 一块也走分块那一套(一格的组):看上去、Tab 起来和直接摆一块一样 —— 占满、没有线、不多出一个能聚焦的东西。
  it('只有一块:占满整屏,没有分界线,也不多出能 Tab 到的东西', async () => {
    screenLayout.show({ kind: 'chat', chatId: 'chat-alone' });
    root!.render(<WorkspaceLayoutContextProvider><ScreenFrame /></WorkspaceLayoutContextProvider>);
    await until('chat block rendered', () => blockWidths().length === 1);
    await nextFrames(3);
    const block = host!.querySelector<HTMLElement>('[data-screen-block]')!.getBoundingClientRect();
    const frame = host!.querySelector<HTMLElement>('[data-screen-frame]')!.getBoundingClientRect();
    expect([block.left, block.top, block.width, block.height]).toEqual([frame.left, frame.top, frame.width, frame.height]);
    expect(separator()).toBeNull();
    expect(host!.querySelectorAll('[data-screen-frame] [role="separator"], [data-screen-frame] [tabindex]:not([data-screen-block] *)').length).toBe(0);
  });

  it('只有一块时宽度一帧一帧地变(收侧栏、拖窗口):分块那一层一个属性都不写', async () => {
    screenLayout.show({ kind: 'chat', chatId: 'chat-alone' });
    root!.render(<WorkspaceLayoutContextProvider><ScreenFrame /></WorkspaceLayoutContextProvider>);
    await until('chat block rendered', () => blockWidths().length === 1);
    await nextFrames(3);
    const frame = host!.querySelector<HTMLElement>('[data-screen-frame]')!;
    const writes: string[] = [];
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        const target = record.target as Element;
        if (target.closest('[data-screen-block]') && target.closest('[data-screen-block]') !== target) continue;
        writes.push(`${target.tagName}.${record.attributeName ?? record.type}`);
      }
    });
    observer.observe(frame, { attributes: true, childList: true, subtree: true });
    for (let width = 1000; width >= 760; width -= 24) {
      host!.style.width = `${width}px`;
      await nextFrames(1);
    }
    await nextFrames(3);
    observer.disconnect();
    expect(blockWidths()).toEqual([760]);
    expect(writes).toEqual([]);
  });

  // 开/收一块时这一刀按 node.sizes 摆,在画出来之前 —— 每一帧都量,❌ 有一帧新挂上的那块是 1%。
  it('收起一块的那一帧起两块就各得一半,没有一帧是 1%', async () => {
    screenLayout.show(s('a'));
    screenLayout.showBeside(s('b'));
    root!.render(<ScreenFrame />);
    await until('两块铺开', () => blockWidths().length === 2 && blockWidths().every((w) => w > 400));
    screenLayout.placeAt({ kind: 'session', projectId: 'p', sessionId: 'c' }, screenLayout.blockOfSession('b')!, 'bottom');
    await until('三块铺开', () => blockWidths().length === 3);
    await nextFrames(5);

    const frames: number[][] = [];
    let sampling = true;
    const sample = () => { frames.push(blockWidths()); if (sampling) requestAnimationFrame(sample); };
    requestAnimationFrame(sample);
    screenLayout.forgetSession('c');
    await until('收成两块', () => blockWidths().length === 2);
    await nextFrames(10);
    sampling = false;
    const twoBlockFrames = frames.filter((widths) => widths.length === 2);
    expect(twoBlockFrames.length).toBeGreaterThan(0);
    expect(twoBlockFrames.filter((widths) => widths.some((w) => w < 400)), JSON.stringify(twoBlockFrames)).toEqual([]);
  });

  it('夹在两块中间新开一块,按 node.sizes 分', async () => {
    screenLayout.show(s('a'));
    screenLayout.showBeside(s('c'));
    root!.render(<ScreenFrame />);
    await until('两块铺开', () => blockWidths().length === 2 && blockWidths().every((w) => w > 400));
    screenLayout.placeAt({ kind: 'session', projectId: 'p', sessionId: 'b' }, screenLayout.blockOfSession('a')!, 'right');
    await until('三块铺开', () => blockWidths().length === 3);
    await nextFrames(10);
    const split = screenLayout.layout!;
    expect(split.type).toBe('split');
    const wanted = (split as Extract<typeof split, { type: 'split' }>).sizes.map((size) => Math.round(size * 10));
    const widths = blockWidths();
    expect(widths.map((w, i) => Math.abs(w - wanted[i]) < 10), `${widths} vs ${wanted}`).toEqual([true, true, true]);
  });

  it('窗口变窄,一块按最窄被夹住:不写回 node.sizes,也不来回打架', async () => {
    screenLayout.show(s('a'));
    screenLayout.showBeside(s('b'));
    root!.render(<ScreenFrame />);
    await until('两块铺开', () => blockWidths().length === 2 && blockWidths().every((w) => w > 400));
    const splitId = screenLayout.layout!.type === 'split' ? screenLayout.layout!.id : '';
    screenLayout.setSplitSizes(splitId, [75, 25]);
    await until('按 75/25 摆好', () => Math.abs(blockWidths()[1] - 250) < 5);

    host!.style.width = '600px'; // 25% = 150px,比一格最窄 220px 还窄:夹到 220
    await nextFrames(5);
    const clamped = blockWidths();
    expect(clamped[1], JSON.stringify(clamped)).toBeGreaterThanOrEqual(219);
    await nextFrames(20);
    expect(blockWidths(), '夹住之后不再动').toEqual(clamped);
    const split = screenLayout.layout!;
    expect(split.type === 'split' && split.sizes, '夹住的不写回 node.sizes').toEqual([75, 25]);
  });

  it('拖到一块的边上 = 分出一块;正中不接;块放不下两半(一格最窄 220px)就不给落点', async () => {
    screenLayout.show(s('a'));
    screenLayout.showBeside(s('b'));
    root!.render(<ScreenFrame />);
    await until('两块铺开', () => blockWidths().length === 2 && blockWidths().every((w) => w > 400));

    const blockB = document.querySelector<HTMLElement>(`[data-screen-block="${screenLayout.blockOfSession('b')}"]`)!.getBoundingClientRect();
    const incoming = { kind: 'session' as const, projectId: 'p', sessionId: 'c' };
    expect(resolveBlockDrop(blockB.left + 10, blockB.top + blockB.height / 2, incoming)).toMatchObject({ edge: 'left' });
    expect(resolveBlockDrop(blockB.left + blockB.width / 2, blockB.top + blockB.height / 2, incoming)).toBeNull();

    // 窄到 400px 宽:两块各 200 都不到 441,左右边上都不接;上下照样能分(500 高 > 160 × 2)。
    host!.style.width = '400px';
    await until('窄到每块不足 230', () => blockWidths().every((w) => w < 230));
    const narrow = document.querySelector<HTMLElement>(`[data-screen-block="${screenLayout.blockOfSession('b')}"]`)!.getBoundingClientRect();
    expect(resolveBlockDrop(narrow.left + 5, narrow.top + narrow.height / 2, incoming)).toBeNull();
    expect(resolveBlockDrop(narrow.left + narrow.width / 2, narrow.bottom - 10, incoming)).toMatchObject({ edge: 'bottom' });
  });

  // owner 2026-10-15「拖到边缘是分屏,中间是 session 信息粘贴」:边带两成(照 dockview),正中落在另一条会话的输入面上 = 插 @ ——
  // 这一屏不收(不 preventDefault,让聊天区 / 终端自己的 drop 插),只画出 @ 会落进去的地方。
  it('边带两成;会话落在另一条会话正中 = 画出插 @ 的落点、不在这一屏收走', async () => {
    screenLayout.show(s('a'));
    screenLayout.showBeside(s('b'));
    root!.render(<ScreenFrame />);
    await until('两块铺开', () => blockWidths().length === 2 && blockWidths().every((w) => w > 400));

    const blockIdB = screenLayout.blockOfSession('b')!;
    const blockB = document.querySelector<HTMLElement>(`[data-screen-block="${blockIdB}"]`)!.getBoundingClientRect();
    const incoming = { kind: 'session' as const, projectId: 'p', sessionId: 'c' };
    const midY = blockB.top + blockB.height / 2;
    // 离左边 25%:原来的三成边带里算「往左分」,现在是正中。
    expect(resolveBlockDrop(blockB.left + blockB.width * 0.25, midY, incoming)).toBeNull();
    expect(resolveBlockDrop(blockB.left + blockB.width * 0.15, midY, incoming)).toMatchObject({ edge: 'left' });

    // 会话页是贴在块上的另一层:这里只摆它的输入面(聊天区 / 终端都带这两个标记)。
    const sessionPage = document.createElement('div');
    sessionPage.setAttribute('data-screen-page', blockIdB);
    const surface = document.createElement('div');
    surface.setAttribute('data-session-chat-surface', 'source');
    surface.setAttribute('data-session-chat-session-id', 'b');
    const transcript = document.createElement('div');
    surface.appendChild(transcript);
    sessionPage.appendChild(surface);
    host!.appendChild(sessionPage);

    const handlers = screenDropHandlers(true);
    const dragOver = (sessionId: string, x: number) => {
      const dataTransfer = new DataTransfer();
      setDraggedScreenContent(dataTransfer, { kind: 'session', sessionId, title: sessionId, projectId: 'p' });
      const preventDefault = vi.fn();
      handlers.onDragOverCapture({ dataTransfer, target: transcript, clientX: x, clientY: midY, preventDefault, stopPropagation: vi.fn() } as never);
      clearDraggedScreenContent();
      return preventDefault;
    };

    const centre = dragOver('c', blockB.left + blockB.width / 2);
    expect(blockDropPreview.get()).toEqual({ blockId: blockIdB, mention: { sessionId: 'b' } });
    expect(centre).not.toHaveBeenCalled();

    const edge = dragOver('c', blockB.left + 10);
    expect(blockDropPreview.get()).toMatchObject({ blockId: blockIdB, edge: 'left' });
    expect(edge).toHaveBeenCalled();

    // 拖它自己到自己的输入面上:@ 自己没有意义,不画。
    dragOver('b', blockB.left + blockB.width / 2);
    expect(blockDropPreview.get()).toBeNull();

    setBlockDropPreview(null);
    sessionPage.remove();
  });

  // 拖 ⋮⋮ 也要开拖拽遮罩:它的 onDragStart 曾经 stopPropagation,React 19 把原生 dragstart 停在根容器上,document 上的
  // shieldNativeDrags 听不到 —— 拖着经过 HTML 预览时指针进了 iframe(复核 659bafb7f 在真 React 上量到)。真组件、真 React 根。
  it('拖 ⋮⋮ 时遮罩开、拖完关', async () => {
    const stop = shieldNativeDrags(document, hasDraggedScreenContent, () => {});
    try {
      root!.render(<BlockGrip label="grip" onDragStart={(event) => startSessionBlockDrag(event, { projectId: 'p', sessionId: 'g', title: 'G' })} />);
      await nextFrames(2);
      const grip = host!.querySelector<HTMLElement>('[data-block-grip]')!;
      const dataTransfer = new DataTransfer();
      grip.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer }));
      expect(document.documentElement.hasAttribute('data-gugu-dragging')).toBe(true);
      grip.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer }));
      expect(document.documentElement.hasAttribute('data-gugu-dragging')).toBe(false);
    } finally {
      stop();
      clearDraggedScreenContent();
    }
  });
});
