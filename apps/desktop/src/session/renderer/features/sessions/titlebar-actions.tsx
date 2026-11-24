import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { flushSync } from 'react-dom';
import {
  TITLEBAR_ACTION_EDGE_GAP_PX,
  TITLEBAR_ACTION_SLOT_GAP_PX,
  TITLEBAR_ACTION_SLOT_WIDTH_PX,
  WINDOW_CONTROL_BAR_HEIGHT_PX,
} from '@/lib/window-chrome';

/**
 * Shared geometry for actions in a task's tab strip. The window's own buttons never sit here: on Windows and Linux they
 * live in the title-bar row above the content (window-chrome hasWindowTitlebarRow), on mac they are the traffic lights.
 *
 * 页签只占剩下的(TabStripShell 的滚动区基准 0),所以放不下时让位的是这一排;它被压窄、按钮放不下时挂
 * `data-tabbar-actions-tight`,「在 X 中打开」那半颗收起(index.css),只留「其他打开方式」—— 下拉里点哪个就用哪个打开,
 * 一样都不少。宽到放得下整排时再放回来(按收起前量到的宽度判,❌ 收起后「放得下了」又放回来、来回跳)。
 */
export function TabBarActionRow({ children }: { children?: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const tight = useTightRow(ref);
  return (
    <div
      ref={ref}
      // 按钮不跟着缩(缩了就量不出「放不下」,10-28 实测关闭钮被压到 18px):放不下只表现为内容比盒子宽。
      className="flex min-w-0 items-center [&>*]:shrink-0"
      // Inline geometry also works outside the skin, whose reset overrides utility-layer spacing.
      style={{
        // 压到最窄时裁在自己这一格里;留 4px 给按钮的焦点环。
        overflow: 'clip',
        overflowClipMargin: '4px',
        height: `${TITLEBAR_ACTION_SLOT_WIDTH_PX}px`,
        marginBlock: `calc((var(--tab-strip-height, ${WINDOW_CONTROL_BAR_HEIGHT_PX}px) - ${TITLEBAR_ACTION_SLOT_WIDTH_PX}px) / 2)`,
        alignSelf: 'flex-start',
        paddingInlineStart: `${TITLEBAR_ACTION_SLOT_GAP_PX * 2}px`,
        paddingInlineEnd: `var(--tabbar-actions-edge-gap, ${TITLEBAR_ACTION_EDGE_GAP_PX}px)`,
        gap: `${TITLEBAR_ACTION_SLOT_GAP_PX}px`,
      }}
      data-tabbar-actions=""
      data-tabbar-actions-tight={tight ? '' : undefined}
    >
      {children}
    </div>
  );
}

/**
 * 这一排放不下(内容比盒子宽)就收。收起后这一排只有内容那么宽,量它自己永远「不够宽」,
 * 所以放回来按能让给它的地方算:它自己加上页签那截(页签本来就先让位)够收起前要的宽度,才放。
 * 内容变了(按钮异步出现、换了名字)、整条变宽变窄都重判。
 */
function useTightRow(ref: RefObject<HTMLDivElement | null>): boolean {
  const [tight, setTight] = useState(false);
  const needed = useRef(0);
  useLayoutEffect(() => {
    const row = ref.current;
    if (!row || typeof ResizeObserver === 'undefined') return;
    const bar = row.closest('.session-tab-bar');
    const tabs = bar?.querySelector<HTMLElement>('[data-tabstrip-scroller]') ?? null;
    // 比边,❌ scrollWidth:overflow:clip 下压进右内边距的那一截不算进 scrollWidth(10-28 实测关闭钮吃掉 6px 边距仍判「放得下」)。
    const over = () => {
      const end = Math.max(...Array.from(row.children, (child) => child.getBoundingClientRect().right));
      return end - (row.getBoundingClientRect().right - TITLEBAR_ACTION_EDGE_GAP_PX);
    };
    const check = () => {
      if (!row.hasAttribute('data-tabbar-actions-tight')) {
        const by = row.children.length ? over() : 0;
        if (by > 0.5) {
          needed.current = row.clientWidth + by;
          setTight(true);
        }
      } else if (row.clientWidth + (tabs?.clientWidth ?? 0) >= needed.current) {
        setTight(false);
      }
    };
    // ❌ check() synchronously here: a layout effect that reads geometry forces a layout in the middle of the commit
    // (the first reader paid for restyling the whole page). The observer's first delivery comes after layout, before
    // paint; flushSync keeps that first paint already collapsed.
    const resize = new ResizeObserver(() => flushSync(check));
    resize.observe(row);
    if (bar) resize.observe(bar);
    const mutation = new MutationObserver(() => flushSync(check));
    mutation.observe(row, { childList: true, subtree: true, characterData: true });
    return () => {
      resize.disconnect();
      mutation.disconnect();
    };
  }, [ref]);
  return tight;
}
