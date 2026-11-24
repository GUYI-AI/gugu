import { ChevronDown } from '@/lib/icons';
import { MicroLabel } from '@renderer/lib/ui/label';
import { cn } from '@renderer/utils/utils';
import { sidebarCountClass, sidebarGroupTitleClass } from './sidebar-primitives';

// 内层侧栏分区头(话题 / 智能体)的收起开关,只写这一处。
// 它是一颗按钮,就要看得出是按钮(刘威 msg:179d0226、6f560538 选 A):箭头常显(展开朝下、收起朝右),整颗(箭头 + 标题 + 数)
// 静止就有一层很浅的胶囊底,三档全是侧栏行已有的 token:静止 row-pinned(置顶行的常驻底,1%)→ 悬停 row-hover(4%)
// → 按下 row-press(6%);光标是手形 —— 与同一列里的行、分区头右端的小钮同一族反馈。
// `count` 给了就画在标题后(话题:稿子上没有也写「0」);不给 = 不画。
export function SidebarGroupToggle({
  label,
  count,
  collapsed,
  onToggle,
  ariaLabel,
}: {
  label: string;
  count?: number;
  collapsed: boolean;
  onToggle: () => void;
  ariaLabel: string;
}) {
  return (
    <button
      type="button"
      data-sidebar-group-toggle=""
      className="group/glabel -ml-[18px] flex h-6 cursor-pointer items-center gap-1 rounded-md bg-row-pinned pr-2 pl-0.5 transition-colors hover:bg-row-hover active:bg-row-press"
      onClick={onToggle}
      aria-label={ariaLabel}
      aria-expanded={!collapsed}
    >
      <ChevronDown
        className={cn(
          'size-3 shrink-0 text-foreground-muted transition-[rotate] duration-[var(--dur-med)] [transition-timing-function:var(--ease)] group-hover/glabel:text-foreground',
          collapsed && '-rotate-90'
        )}
      />
      {/* @@@sidebar-type-scale (owner 2026-09-05,以 Codex 实测为准) —
          字号:Codex 的同位标题(置顶/项目/最近)实测 13.5px,咕咕原来 11.5px。
          咕咕刻度只有 14/12,13.5 落到 14(text-sm),覆盖掉 MicroLabel 自带的 text-xs。
          颜色:10-28 起静止态 foreground-muted(侧栏底上 5.22 / 6.10),仍比行字浅一档;悬停 / 按下到 foreground。 */}
      <MicroLabel
        className={cn(
          sidebarGroupTitleClass,
          'group-hover/glabel:text-foreground group-active/glabel:text-foreground'
        )}
      >
        {label}
      </MicroLabel>
      {/* 稿子上数在标题后 12px:gap 4 + ml 8。 */}
      {count === undefined ? null : <span className={cn(sidebarCountClass, 'ml-2')}>{count}</span>}
    </button>
  );
}
