/**
 * 一块的页签条窄了,右端那一排(TabBarActionRow)是让位的那个:放不下时「在 X 中打开」那半颗收起,「其他打开方式」与
 * 关闭还在;宽回来再放出来。窗口自己的按钮不在这条带里(Windows / Linux 在标题栏行,mac 是红绿灯),这一排一路排到条的右端。
 * 真 Chromium、真 CSS、真页签条(TabStripShell + TabBarActionRow);「在 X 中打开」照那颗分裂按钮的形状搭。
 */
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it } from 'vitest';
import { until } from '../../../../../../../tests/support/awaitCondition';
import '@/styles/tokens.css';
import '@renderer/index.css';
import { MessageSquare } from '@/lib/icons';
import { TabStripShell } from '@renderer/features/tabs/tab-bar';
import { TabChip, TabSlot } from '@renderer/features/tabs/tab-bar/tab-chip';
import { TabBarActionRow } from '@renderer/features/sessions/titlebar-actions';

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  root?.unmount();
  host?.remove();
  root = null;
  host = null;
});

function SessionBlockActions() {
  return (
    <TabBarActionRow>
      <div style={{ display: 'flex', alignItems: 'center', height: 28 }}>
        <button data-open-in-primary="" aria-label="在文件中打开" style={{ width: 28, height: 28 }} />
        <button aria-label="其他打开方式" style={{ width: 28, height: 28 }} />
      </div>
      <button aria-label="关闭这一块" style={{ width: 24, height: 24 }} />
    </TabBarActionRow>
  );
}

const frames = async (n = 4) => { for (let i = 0; i < n; i += 1) await new Promise(requestAnimationFrame); };

async function mount(width: number) {
  host = document.createElement('div');
  host.className = 'emlight gugu-skin';
  host.style.width = `${width}px`;
  document.body.appendChild(host);
  root = createRoot(host);
  root.render(
    <TabStripShell trailingSlot={<button style={{ width: 28, height: 28 }}>+</button>} actionsSlot={<SessionBlockActions />}>
      <TabSlot>
        <TabChip isActive label="Reply ok one" preSlot={<MessageSquare className="size-3" />} closeLabel="关闭" onClose={() => undefined} data-tabid="s" />
      </TabSlot>
    </TabStripShell>
  );
  await until('strip rendered', () => host!.querySelector('[data-tabid="s"]') !== null);
  await frames();
}

async function resize(width: number) {
  host!.style.width = `${width}px`;
  await frames();
}

function measure() {
  const bar = host!.querySelector<HTMLElement>('.session-tab-bar')!.getBoundingClientRect();
  const shown = (label: string) => {
    const el = host!.querySelector<HTMLElement>(`button[aria-label="${label}"]`)!;
    return el.getBoundingClientRect().width > 0 ? el.getBoundingClientRect() : null;
  };
  return { bar, primary: shown('在文件中打开'), more: shown('其他打开方式'), close: shown('关闭这一块') };
}

const NARROW = 100;

it('a narrow block: the row does not fit whole, so Open in folds and Other ways / close stay inside the strip', async () => {
  await mount(NARROW);
  const { bar, primary, more, close } = measure();
  expect(primary).toBeNull();
  expect(more).not.toBeNull();
  expect(close).not.toBeNull();
  expect(close!.width, 'close keeps its size').toBeCloseTo(24, 0);
  expect(close!.right).toBeLessThanOrEqual(bar.right);
});

it('a wide block keeps Open in; narrowing folds it, widening brings it back', async () => {
  await mount(600);
  expect(measure().primary, 'wide: Open in shown').not.toBeNull();
  expect(measure().close!.right).toBeLessThanOrEqual(measure().bar.right);
  await resize(NARROW);
  expect(measure().primary, 'narrow: folded').toBeNull();
  await resize(600);
  expect(measure().primary, 'wide again: back').not.toBeNull();
});
