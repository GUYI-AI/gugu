// #7341 项目首页的文件夹卡与它的数据(product spec「项目首页」)。
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setLocalePreference } from '@/i18n';
import type { GroupFolder } from '@renderer/features/folders/group-folders-store';
import { SessionLocalizationProvider } from '@renderer/localization/localization-provider';
import { ProjectFolderCard, shortHome, FAN_MAX_ROWS, FAN_ROW_MAX, fanPlace } from './project-folder-card';
import type { GroupFoldersState } from '@renderer/features/folders/group-folders';

const mocks = vi.hoisted(() => ({
  entries: new Map<string, Array<{ sessionId: string; group: 'working' | 'needs-you' | null; time: number; title: string }>>(),
}));

vi.mock('@renderer/lib/stores/app-state', () => ({
  sidebarStore: { placement: { entries: mocks.entries } },
}));
vi.mock('@renderer/lib/chat/sender-avatar', () => ({
  senderAvatarUrl: (fromId: string) => `avatar:${fromId}`,
  subscribeSenderAvatars: () => () => {},
}));
vi.mock('@renderer/features/folders/group-folders-store', () => ({
  groupFoldersStore: { readMachine: vi.fn() },
  folderName: (path: string) => path.split('/').pop() ?? path,
}));

let nextSort = 1;
const folder = (id: string, path: string, sessionIds: string[] = [], deviceId: string | null = null): GroupFolder => {
  const sort = nextSort++;
  return {
    id,
    path,
    chatId: 'g1',
    deviceId,
    sort,
    gitless: false,
    branch: null,
    sessionIds,
    attachedAt: sort === 1 ? null : new Date().toISOString(),
    offline: false,
  };
};
const ROOT = folder('ws-root', '/www/gugu', ['s1']);
const WT = folder('ws-wt', '/www/gugu-wt', ['s2']);
const OTHER = folder('ws-other', '/www/gugu-supabase');
const EXTRA = folder('ws-extra', '/www/gugu-web');

function stateOf(partial: Partial<GroupFoldersState>): GroupFoldersState {
  return {
    folders: [ROOT, WT, OTHER, EXTRA],
    loadError: false,
    stale: false,
    chosen: ROOT,
    fresh: undefined,
    choose: vi.fn(),
    reload: vi.fn(),
    bound: vi.fn(),
    detach: vi.fn(),
    ...partial,
  };
}

describe('ProjectFolderCard', () => {
  let dom: JSDOM;
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost' });
    vi.stubGlobal('window', dom.window);
    vi.stubGlobal('document', dom.window.document);
    vi.stubGlobal('HTMLElement', dom.window.HTMLElement);
    vi.stubGlobal('Element', dom.window.Element);
    vi.stubGlobal('Node', dom.window.Node);
    vi.stubGlobal('Event', dom.window.Event);
    vi.stubGlobal('CustomEvent', dom.window.CustomEvent);
    vi.stubGlobal('KeyboardEvent', dom.window.KeyboardEvent);
    vi.stubGlobal('localStorage', dom.window.localStorage);
    container = dom.window.document.querySelector('#root') as HTMLDivElement;
    root = createRoot(container);
    setLocalePreference('zh-CN');
    mocks.entries.clear();
  });

  afterEach(() => {
    act(() => root.unmount());
    vi.unstubAllGlobals();
    dom.window.close();
  });

  async function renderCard(
    state: GroupFoldersState,
    extra: {
      onAttach?: (machine: string | null) => void;
      onAddMachine?: () => void;
      onDropFolder?: (file: File) => void;
      machines?: (string | null)[];
      machineOf?: (deviceId: string | null) => { label: string; online: boolean; kind: 'server' | 'computer' };
    } = {}
  ) {
    await act(async () => {
      root.render(
        React.createElement(
          SessionLocalizationProvider,
          null,
          React.createElement(ProjectFolderCard, {
            chatId: 'g1',
            groupName: 'gugu',
            folders: state,
            machines: extra.machines ?? [null],
            machineOf: extra.machineOf ?? (() => ({ label: 'd22', online: true, kind: 'server' as const })),
            // 只有一台能挂:「+」直接去挑文件夹(多台时先弹机器菜单)。
            attachMachines: [{ id: null, label: '这台电脑', online: true, kind: 'computer' as const }],
            onAttach: extra.onAttach ?? vi.fn(),
            onAddMachine: extra.onAddMachine,
            onDropFolder: extra.onDropFolder ?? vi.fn(),
          })
        )
      );
    });
  }
  const papers = () => [...container.querySelectorAll<HTMLElement>('[data-testid="project-folder-paper"]')];
  const slotOf = (paper: HTMLElement) => paper.closest('.gg-folder-paper-slot') as HTMLElement;
  /** 露出来的那几页(收起时其余的透明地藏在叠底,仍在 DOM 里 —— 摊开才有过渡可走)。 */
  const visible = () => papers().filter((paper) => slotOf(paper).getAttribute('data-peek') === 'shown');
  const toggle = () => container.querySelector<HTMLElement>('[data-testid="project-folder-card-toggle"]');

  it('peeks the three most relevant folders: just attached, then the chosen one, then the root', async () => {
    await renderCard(stateOf({ chosen: WT, fresh: OTHER.id }));
    // 收起时只露三页,按相关程度:刚挂上的、选中的、根目录;第四页藏在叠底。
    expect(visible().map((p) => p.getAttribute('title'))).toEqual(['/www/gugu-supabase', '/www/gugu-wt', '/www/gugu']);
    expect(papers()).toHaveLength(4);
    // 最相关的那页压在最上面。
    const top = [...papers()].sort((a, b) => Number(slotOf(b).style.zIndex) - Number(slotOf(a).style.zIndex))[0];
    expect(top.getAttribute('title')).toBe('/www/gugu-supabase');
    expect(container.textContent).toContain('刚挂上');
    expect(container.textContent).toContain('4 个文件夹');
  });

  it('counts only this group’s own sessions, and how many are running', async () => {
    mocks.entries.set('g1', [
      { sessionId: 's1', group: 'working', time: 2, title: 'a' },
      { sessionId: 's2', group: null, time: 1, title: 'b' },
    ]);
    // 别的群的会话:不算这个群的。
    mocks.entries.set('g2', [{ sessionId: 's9', group: 'working', time: 3, title: 'c' }]);
    await renderCard(stateOf({}));
    expect(container.textContent).toContain('2 个会话');
    expect(container.textContent).toContain('1 个在跑');
    expect(container.textContent).not.toContain('2 个在跑');
    // 在跑的那个会话从根目录开工 ⇒ 根目录那页写「1 个会话在这儿跑」。
    expect(papers().find((p) => p.getAttribute('title') === '/www/gugu')?.textContent).toContain('1 个会话在这儿跑');
    // 头像只来自这个群自己的会话。
    expect([...container.querySelectorAll('img')].map((img) => img.getAttribute('src')).sort()).toEqual(['avatar:session:s1', 'avatar:session:s2']);
  });

  it('counts each session once and explains six visible agents plus two more', async () => {
    const entries = Array.from({ length: 8 }, (_, i) => ({
      sessionId: `s${i}`, group: null, time: 8 - i, title: `agent ${i}`,
    }));
    mocks.entries.set('g1', [...entries, entries[0]!]);
    await renderCard(stateOf({}));
    expect(container.textContent).toContain('8 个会话');
    expect(container.querySelectorAll('.gg-folder-card__agents img')).toHaveLength(6);
    expect(container.querySelector('.gg-folder-card__agents')?.getAttribute('title')).toBe('共 8 个 Agent');
    const more = container.querySelector('.gg-folder-card__more');
    expect(more?.textContent).toBe('共 8 位');
    expect(more?.getAttribute('aria-label')).toBe('另有 2 个 Agent');
    expect(more?.getAttribute('title')).toBe('agent 6\nagent 7');
  });

  it('says how many sessions started in a folder even when none is running, and drops the stale fresh mark', async () => {
    const stale = { ...OTHER, attachedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString() };
    await renderCard(stateOf({ folders: [ROOT, WT, stale], fresh: stale.id }));
    // WT 里开过一个会话、此刻歇着:写「1 个会话」,❌「还没有会话」。
    expect(papers().find((p) => p.getAttribute('title') === '/www/gugu-wt')?.textContent).toContain('1 个会话');
    expect(papers().find((p) => p.getAttribute('title') === '/www/gugu-supabase')?.textContent).toContain('还没有会话');
    // 十分钟前挂上的不再标「刚挂上」。
    expect(container.textContent).not.toContain('刚挂上');
  });

  it('marks each folder with its own machine, offline ones greyed, and lists every machine on the card', async () => {
    // 每页纸读它自己记着的那台(folder.deviceId)。
    const remote = { ...folder('ws-d15', '/srv/gugu', [], 'd15'), offline: true };
    await renderCard(stateOf({ folders: [ROOT, remote] }), {
      machines: [null, 'd15'],
      machineOf: (deviceId) => (deviceId === 'd15' ? { label: 'd15', online: true, kind: 'server' } : { label: '这台电脑', online: true, kind: 'computer' }),
    });
    const d15Paper = papers().find((p) => p.getAttribute('title') === '/srv/gugu');
    expect(d15Paper?.textContent).toContain('d15');
    // 那台此刻答不上(列的是上次读到的):纸上那颗点灰掉。
    expect(d15Paper?.querySelector('.gg-folder-chip__dot')?.classList.contains('is-offline')).toBe(true);
    const foot = container.querySelector('.gg-folder-card__machines')?.textContent ?? '';
    expect(foot).toContain('这台电脑');
    expect(foot).toContain('d15');
    expect(container.querySelector('[data-testid="project-folder-stale"]'), 'read this time: no stale mark').toBeNull();
  });

  it('labels an offline folder when the account’s record could not be read this time', async () => {
    const remote = { ...folder('ws-d15', '/srv/gugu', [], 'd15'), offline: true };
    await renderCard(stateOf({ folders: [ROOT, remote], stale: true }), {
      machines: [null, 'd15'],
      machineOf: (deviceId) => (deviceId === 'd15' ? { label: 'd15', online: true, kind: 'server' } : { label: '这台电脑', online: true, kind: 'computer' }),
    });
    const stale = [...container.querySelectorAll('[data-testid="project-folder-stale"]')];
    expect(stale).toHaveLength(1);
    expect(papers().find((p) => p.getAttribute('title') === '/srv/gugu')?.contains(stale[0]!)).toBe(true);
  });

  it('spreads every folder on click, picks one, and closes again', async () => {
    const state = stateOf({});
    await renderCard(state);
    expect(toggle()?.getAttribute('aria-expanded')).toBe('false');
    expect(visible()).toHaveLength(3);
    const nodesBefore = papers();

    await act(async () => toggle()?.click());
    expect(toggle()?.getAttribute('aria-expanded')).toBe('true');
    expect(visible()).toHaveLength(4);
    // 摊开不换节点、不挪顺序:同一批 DOM 节点原地变位置,浏览器才有过渡可走(挪动 / 新挂的节点会瞬移)。
    expect(papers().length).toBe(nodesBefore.length);
    expect(papers().every((paper, i) => paper === nodesBefore[i])).toBe(true);
    expect(container.textContent).toContain('选择新任务的工作目录，再点卡片可收起。');

    const extra = papers().find((p) => p.getAttribute('title') === '/www/gugu-web');
    await act(async () => extra?.click());
    expect(state.choose).toHaveBeenCalledWith('ws-extra');
    // 点纸 ≠ 点卡片:选完仍摊开着,可以接着换。
    expect(toggle()?.getAttribute('aria-expanded')).toBe('true');

    await act(async () => {
      dom.window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(toggle()?.getAttribute('aria-expanded')).toBe('false');
  });

  it('a click on a peeking paper while closed opens the card instead of choosing', async () => {
    const state = stateOf({});
    await renderCard(state);
    await act(async () => visible()[0]?.click());
    expect(state.choose).not.toHaveBeenCalled();
    expect(toggle()?.getAttribute('aria-expanded')).toBe('true');
  });

  it('the + button asks to attach without spreading the card', async () => {
    const onAttach = vi.fn();
    await renderCard(stateOf({}), { onAttach });
    await act(async () => container.querySelector<HTMLElement>('[data-testid="project-folder-attach"]')?.click());
    expect(onAttach).toHaveBeenCalledTimes(1);
    expect(onAttach).toHaveBeenCalledWith(null);
    expect(toggle()?.getAttribute('aria-expanded')).toBe('false');
  });

  it('hands a dropped Finder folder to the caller, and ignores drags without files', async () => {
    const onDropFolder = vi.fn();
    await renderCard(stateOf({}), { onDropFolder });
    const card = container.querySelector('[data-testid="project-folder-card"]') as HTMLElement;
    const file = new dom.window.File([''], 'gugu-supabase');
    const drop = (types: string[], files: File[]) => {
      const event = new dom.window.Event('drop', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'dataTransfer', { value: { types, files } });
      card.dispatchEvent(event);
    };
    await act(async () => drop(['text/plain'], []));
    expect(onDropFolder).not.toHaveBeenCalled();
    await act(async () => drop(['Files'], [file]));
    expect(onDropFolder).toHaveBeenCalledWith(file);
  });

  it('shows loading instead of zero folders and waits before allowing the card to open', async () => {
    await renderCard(stateOf({ folders: null, chosen: null }));
    expect(container.textContent).toContain('正在读取文件夹');
    expect(container.textContent).not.toContain('0 个文件夹');
    await act(async () => container.querySelector<HTMLElement>('[data-testid="project-folder-card"]')?.click());
    expect(toggle()?.getAttribute('aria-expanded')).toBe('false');

    await renderCard(stateOf({ folders: [ROOT] }));
    expect(container.textContent).toContain('1 个文件夹');
    expect(container.textContent).not.toContain('正在读取文件夹');
    await act(async () => toggle()?.click());
    expect(toggle()?.getAttribute('aria-expanded')).toBe('true');
  });

  it('says it could not read the folders instead of passing the root off as all of them', async () => {
    const state = stateOf({ folders: null, chosen: null, loadError: true });
    await renderCard(state);
    expect(papers()).toHaveLength(0);
    expect(container.textContent).toContain('读不到这个群的文件夹');
    expect(container.textContent).not.toContain('0 个文件夹');
    const retry = [...container.querySelectorAll('button')].find((b) => b.textContent === '重试');
    await act(async () => retry?.click());
    expect(state.reload).toHaveBeenCalledTimes(1);
  });

  it('draws a group with no folder at all: no papers, and says 0 folders', async () => {
    await renderCard(stateOf({ folders: [], chosen: null }));
    expect(papers()).toHaveLength(0);
    expect(container.textContent).toContain('0 个文件夹');
    expect(container.textContent).not.toContain('正在读取文件夹');
  });
});

describe('shortHome', () => {
  it('writes the home prefix as ~ and leaves everything else alone', () => {
    expect(shortHome('/Users/apple/Desktop/projects/gugu')).toBe('~/Desktop/projects/gugu');
    expect(shortHome('/home/dev/repo')).toBe('~/repo');
    expect(shortHome('/root')).toBe('~');
    expect(shortHome('C:\\Users\\me\\code')).toBe('~\\code');
    // 只认整段前缀:/Users/applesauce 不是 /Users/apple 的家 —— 换的是它自己的家,不是截半个名字。
    expect(shortHome('/Users/applesauce/x')).toBe('~/x');
    expect(shortHome('/www/gugu')).toBe('/www/gugu');
    expect(shortHome('/rootless/x')).toBe('/rootless/x');
  });
});

describe('fanPlace', () => {
  const hand = (count: number, column = 960) =>
    Array.from({ length: count }, (_, slot) => fanPlace(slot, count, { column, paperW: 200, paperH: 64, key: `ws-${slot}` }));
  const rowSizes = (count: number, column = 960) => {
    const sizes = new Map<number, number>();
    for (const p of hand(count, column)) sizes.set(p.row, (sizes.get(p.row) ?? 0) + 1);
    return [...sizes.values()];
  };

  it('puts slot 0 (the chosen folder) in the front row, rightmost and on top of everything', () => {
    for (const count of [2, 6, 12, 20]) {
      const places = hand(count);
      expect(places[0].row).toBe(0);
      expect(places[0].z).toBe(Math.max(...places.map((p) => p.z)));
      const front = places.filter((p) => p.row === 0);
      expect(places[0].x).toBe(Math.max(...front.map((p) => p.x)));
    }
  });

  it('within a row the right paper covers the left one, and a front row covers every row behind it', () => {
    const places = hand(20);
    for (const row of new Set(places.map((p) => p.row))) {
      const inRow = places.filter((p) => p.row === row).sort((a, b) => a.x - b.x);
      expect(inRow.map((p) => p.z)).toEqual([...inRow.map((p) => p.z)].sort((a, b) => a - b));
    }
    const minFront = Math.min(...places.filter((p) => p.row === 0).map((p) => p.z));
    expect(Math.max(...places.filter((p) => p.row > 0).map((p) => p.z))).toBeLessThan(minFront);
  });

  it('holds at most six a row, split evenly, and never more than five rows', () => {
    expect(rowSizes(6)).toEqual([6]);
    expect(rowSizes(20)).toEqual([5, 5, 5, 5]);
    for (const column of [360, 480, 600, 960, 1400]) {
      for (const count of [1, 7, 13, 20]) {
        const sizes = rowSizes(count, column);
        expect(Math.max(...sizes)).toBeLessThanOrEqual(FAN_ROW_MAX);
        expect(sizes.length).toBeLessThanOrEqual(FAN_MAX_ROWS);
        expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
      }
    }
  });

  it('a narrow column takes more rows instead of squeezing the names', () => {
    expect(rowSizes(20, 480).length).toBeGreaterThan(rowSizes(20, 1200).length);
  });

  it('back rows rise above the front row', () => {
    const places = hand(20);
    const lowest = (row: number) => Math.max(...places.filter((p) => p.row === row).map((p) => p.y));
    expect(lowest(1)).toBeLessThan(lowest(0));
  });

  it('the same folder lands in the same spot every time', () => {
    expect(fanPlace(3, 12, { column: 900, paperW: 200, paperH: 64, key: 'ws-a' })).toEqual(
      fanPlace(3, 12, { column: 900, paperW: 200, paperH: 64, key: 'ws-a' })
    );
  });
});
