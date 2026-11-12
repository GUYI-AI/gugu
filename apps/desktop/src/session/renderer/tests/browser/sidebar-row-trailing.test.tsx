/**
 * 侧栏会话行的行尾(owner 11-05:「为啥一个数字和右边的小黄点之间没有任何的东西,平白压缩了 title 的空间」)。
 * 不变量:标题吃掉全部剩余宽度;行尾的子会话计数与状态格各按内容取宽、紧挨着贴右,中间只有固定的小间距;
 * 行内没有空着的预留区。真 Chromium、真 CSS —— 要判的是 flex 最终排出来的几何。
 */
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { userEvent } from 'vitest/browser';
import { until } from '../../../../../../../tests/support/awaitCondition';
import { presentAgentStatus } from '@gugu/core/shared/agentStatusPresentation';
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
const tree = (total: number, active: number): SessionBranchSummary => ({
  total, active: active > 0 ? [{ count: active, presentation: running }] : [],
});

async function mount(rows: { id: string; tree?: SessionBranchSummary; expanded?: boolean; needsAttention?: boolean }[]) {
  root.render(
    <SessionLocalizationProvider>
      {rows.map((row) => (
        <SessionRowShell
          key={row.id}
          sessionId={row.id} rowVariant="tree" depth={0} hasChildren={row.tree !== undefined} expanded={row.expanded ?? false}
          needsAttention={row.needsAttention ?? false} treeSummary={row.tree} title={LONG_TITLE} harness={null}
          presentation={presentAgentStatus({ reading: { status: 'idle', detail: null } })}
          lastInteractedAt={new Date(Date.now() - 3 * 3600_000).toISOString()}
          doneUnread={false} isActive={false} isCursor={false} isPendingArchive={false}
          quickActions={{ isPinned: false, onSetPinned: () => {}, archiveLabel: 'Archive', onArchive: () => {} }}
          onOpen={() => {}}
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
    count: count ? rect(count) : null,
    rest: rect(rest),
    restContentWidth: restContent.reduce((sum, box) => sum + box.width, 0),
    contentRight: rowBox.right - padEnd,
  };
}

it('keeps the count and the status side by side against the right edge, leaving the rest to the title', async () => {
  const cases = [
    { id: 'none-dot', needsAttention: true },
    { id: 'zero', tree: tree(0, 0) },
    { id: 'one-digit-dot', tree: tree(7, 0), needsAttention: true },
    { id: 'two-digit-dot-expanded', tree: tree(38, 2), expanded: true, needsAttention: true },
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
