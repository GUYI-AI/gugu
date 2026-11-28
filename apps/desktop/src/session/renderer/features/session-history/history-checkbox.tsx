import { Checkbox as CheckboxPrimitive } from '@base-ui/react/checkbox';
import type { MouseEvent } from 'react';
import { CheckIcon, Minus } from '@/lib/icons';
import { cn } from '@renderer/utils/utils';
import type { CheckState } from './history-selection';

/**
 * 会话历史的勾选框:行外左侧那一格、节头左侧那一格、底部条上那一格共用。三态 —— 节头选了一部分、底部条没选全时是横杠
 * (第 2 稿 .cb.mix)。样子与 lib/ui/checkbox 同一套 token,只多了横杠那一态。
 * 点击事件交给调用方(要读 Shift / ⌘),❌ 走 onCheckedChange:那里拿不到修饰键。
 * Base UI 的 Root 被点时会在旁边那个隐藏 input 上再派一次冒泡的 click:外面包一层把它截住,
 * 否则它冒到行 / 节头上,行在多选里再勾一遍(等于没勾)、节头跟着展开收起。
 */
export function HistoryCheckbox({
  state,
  label,
  onClick,
  className,
  testId,
  disabled,
}: {
  state: CheckState;
  label: string;
  onClick: (event: MouseEvent<HTMLElement>) => void;
  className?: string;
  testId?: string;
  disabled?: boolean;
}) {
  return (
    <span className="contents" onClick={(event) => event.stopPropagation()}>
      <CheckboxPrimitive.Root
        checked={state === 'on'}
        indeterminate={state === 'mixed'}
        disabled={disabled}
        aria-label={label}
        data-testid={testId}
        data-state={state}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onClick(event);
        }}
        className={cn(
          'relative flex size-4 shrink-0 items-center justify-center rounded-sm border border-border-1 bg-background after:absolute after:-inset-x-3 after:-inset-y-2 disabled:cursor-not-allowed disabled:opacity-50 data-checked:border-background-neutral data-checked:bg-background-neutral data-checked:text-foreground-neutral data-indeterminate:border-background-neutral data-indeterminate:bg-background-neutral data-indeterminate:text-foreground-neutral',
          className
        )}
      >
        <CheckboxPrimitive.Indicator keepMounted={false} className="grid place-content-center text-current [&>svg]:size-3">
          {state === 'mixed' ? <Minus absoluteStrokeWidth strokeWidth={3} /> : <CheckIcon absoluteStrokeWidth strokeWidth={3} />}
        </CheckboxPrimitive.Indicator>
      </CheckboxPrimitive.Root>
    </span>
  );
}
