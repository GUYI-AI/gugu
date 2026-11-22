/**
 * 侧栏会话行的行尾(owner 11-05:「为啥一个数字和右边的小黄点之间没有任何的东西,平白压缩了 title 的空间」)。
 * 不变量:标题吃掉全部剩余宽度;行尾的子会话计数与状态格各按内容取宽、紧挨着贴右,中间只有固定的小间距;
 * 行内没有空着的预留区。悬浮时这套几何一个像素不动:置顶 / 归档贴右缘叠画在计数与标题尾巴上(owner 11-22 选 b),
 * 不为它们让宽 —— 否则标题一悬浮就变短、跑马灯从头再走。真 Chromium、真 CSS —— 要判的是 flex 最终排出来的几何。
 */
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { userEvent } from 'vitest/browser';
import { until } from '../../../../../../../tests/support/awaitCondition';
import { presentAgentStatus, type AgentStatusPresentation } from '@gugu/core/shared/agentStatusPresentation';
import { chatAgentSection } from '@renderer/features/sidebar/chat-agents';
import { SessionRowShell } from '@renderer/features/sidebar/sidebar-session-row';
import type { SessionBranchSummary } from '@renderer/features/sidebar/sidebar-session-branch';
import { SessionLocalizationProvider } from '@renderer/localization/localization-provider';
import '@/styles/tokens.css';
import '@renderer/index.css';

const LONG_TITLE = '总管（juma3）把这一车道的进度、证据和交接件整理好再汇报';
let root: Root;
let host: HTMLDivElement;
let park: HTMLDivElement;

beforeEach(async () => {
  // 指针停在别处:上一个测试文件留下的指针位置会让第一行处于 hover。
  park = document.createElement('div');
  park.style.cssText = 'position:fixed;right:0;bottom:0;width:40px;height:40px';
  document.body.append(park);
  await userEvent.hover(park);
  host = document.createElement('div');
  host.className = 'gugu-skin emlight';
  host.style.width = '260px';
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => { root.unmount(); host.remove(); park.remove(); });

const running = presentAgentStatus({ reading: { status: 'working', detail: null } });
const asking = presentAgentStatus({ reading: { status: 'needs_user', detail: null } });
const tree = (total: number, active: number): SessionBranchSummary => ({
  total, active: active > 0 ? [{ count: active, presentation: running }] : [],
});

type Row = { id: string; tree?: SessionBranchSummary; expanded?: boolean; presentation?: AgentStatusPresentation };

async function mount(rows: Row[], extra: (row: Row) => object = () => ({})) {
  root.render(
    <SessionLocalizationProvider>
      {rows.map((row) => (
        <SessionRowShell
          key={row.id}
          sessionId={row.id} rowVariant="tree" depth={0} hasChildren={row.tree !== undefined} expanded={row.expanded ?? false}
          treeSummary={row.tree} title={LONG_TITLE} harness={null}
          presentation={row.presentation ?? presentAgentStatus({ reading: { status: 'idle', detail: null } })}
          lastInteractedAt={new Date(Date.now() - 3 * 3600_000).toISOString()}
          doneUnread={false} isActive={false} isCursor={false} isPendingArchive={false}
          quickActions={{ isPinned: false, onSetPinned: () => {}, archiveLabel: 'Archive', onArchive: () => {} }}
          onOpen={() => {}}
          {...extra(row)}
        />
      ))}
    </SessionLocalizationProvider>,
  );
  await until('rows rendered', () => host.querySelectorAll('[data-session-id]').length === rows.length);
}

function trailing(id: string) {
  const row = host.querySelector<HTMLElement>(`[data-session-id="${id}"]`)!;
  const rect = (el: Element | null) => el!.getBoundingClientRect();
  const rowBox = rect(row);
  const padEnd = Number.parseFloat(getComputedStyle(row).paddingRight);
  const count = row.querySelector('[data-session-branch-count]');
  const rest = row.querySelector('[data-row-hover-actions] > :last-child')!;
  const restContent = Array.from(rest.children).map((el) => rect(el));
  return {
    title: rect(row.querySelector('button.flex-1 > span:last-child')),
    actions: rect(row.querySelector('[data-row-hover-actions] > :first-child')),
    count: count ? rect(count) : null,
    rest: rect(rest),
    restContentWidth: restContent.reduce((sum, box) => sum + box.width, 0),
    contentRight: rowBox.right - padEnd,
  };
}

it('keeps the count and the status side by side against the right edge, leaving the rest to the title', async () => {
  const cases = [
    { id: 'none-dot', presentation: asking },
    { id: 'zero', tree: tree(0, 0) },
    { id: 'one-digit-dot', tree: tree(7, 0), presentation: asking },
    { id: 'two-digit-dot-expanded', tree: tree(38, 2), expanded: true, presentation: asking },
    { id: 'two-digit-time', tree: tree(38, 0) },
    { id: 'two-digit-running', tree: tree(38, 12) },
  ];
  await mount(cases);
  const gaps = new Set<number>();
  for (const { id } of cases) {
    const row = trailing(id);
    // 状态格只占自己内容的宽,而且贴着行的右缘。
    expect(row.rest.width, id).toBeCloseTo(row.restContentWidth, 0);
    expect(row.rest.right, id).toBeCloseTo(row.contentRight, 0);
    if (row.count) {
      // 计数紧挨着状态格:两者之间是一个与计数位数、状态种类都无关的固定间距。
      gaps.add(Math.round(row.rest.left - row.count.right));
      // 标题一直延伸到计数跟前。
      expect(row.count.left - row.title.right, id).toBeLessThanOrEqual(4.5);
    } else {
      expect(row.rest.left - row.title.right, id).toBeLessThanOrEqual(12.5);
    }
  }
  expect([...gaps]).toEqual([12]);
});

it('hovering draws the actions over the row end without moving the title, the count or the status', async () => {
  const cases = [
    { id: 'none-dot', presentation: asking },
    { id: 'two-digit-dot', tree: tree(38, 0), presentation: asking },
    { id: 'two-digit-time', tree: tree(38, 0) },
  ];
  await mount(cases);
  for (const { id } of cases) {
    const row = host.querySelector<HTMLElement>(`[data-session-id="${id}"]`)!;
    const rest = trailing(id);
    await userEvent.hover(row);
    await until(`${id} hovered`, () => row.matches(':hover'));
    const hovered = trailing(id);
    // DOMRect keeps its fields on the prototype; compare plain values.
    expect(hovered.title.toJSON(), id).toEqual(rest.title.toJSON());
    expect(hovered.rest.toJSON(), id).toEqual(rest.rest.toJSON());
    expect(hovered.count?.toJSON(), id).toEqual(rest.count?.toJSON());
    // The actions sit against the right edge and reach over what is left of them (the count, else the title's tail).
    expect(hovered.actions.right, id).toBeCloseTo(hovered.contentRight, 0);
    expect(hovered.actions.left, id).toBeLessThan((hovered.count ?? hovered.title).right);
    await userEvent.hover(park);
  }
});

it('a child in error leaves the running parent showing its own running state', async () => {
  const failed = presentAgentStatus({ reading: { status: 'error', detail: null } });
  const entry = (id: string, presentation: AgentStatusPresentation, parentSessionId?: string) =>
    ({ id, projectId: 'p', time: 1, presentation, parentSessionId });
  // The agents section's own rows, rendered as the inner sidebar renders them.
  const { rows } = chatAgentSection([entry('parent', running), entry('child', failed, 'parent')], { expanded: new Set(), showAll: false });
  await mount([{ id: 'alone', presentation: running }, { id: 'parent', presentation: running, tree: rows[0]!.summary }], (row) =>
    row.id === 'parent' ? rows[0]! : {});
  const labels = (id: string) => Array.from(host.querySelectorAll(`[data-session-id="${id}"] [data-row-hover-actions] > :last-child [aria-label]`), (el) => el.getAttribute('aria-label'));
  expect(labels('alone')).toHaveLength(1);
  expect(labels('parent')).toEqual(labels('alone'));
});
