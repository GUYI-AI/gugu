import { sidebarStore } from '@renderer/lib/stores/app-state';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { SidebarMenuAction, SidebarMenuRow } from './sidebar-primitives';

// @@@sessionpage — "Show more / Show less" toggle for the idle families folded away in a project or the
// Tasks section (spec session-page: idle families beyond the cap collapse behind this row, Codex's 展开显示).
// #2548 the inner sidebar reuses the same row for its other folds (「还有 N 个在运行」「全部 N 个话题」): own label, own toggle.
export function SidebarMoreRow({
  foldKey,
  expanded,
  hiddenCount,
  label: ownLabel,
  onToggle,
}: {
  /** 「展开显示」那张表(sidebarStore.idleExpandedProjectIds)里的键。 */
  foldKey: string;
  expanded: boolean;
  hiddenCount: number;
  /** 收着时的字(缺省「展开显示 (N)」);展开后一律「收起」。 */
  label?: string;
  /** 缺省 = 侧栏那张「展开显示」表(sidebarStore.toggleIdleExpanded(foldKey))。 */
  onToggle?: () => void;
}) {
  const { translate } = useSessionMessages();
  const label = expanded
    ? translate('sidebar.showLess')
    : ownLabel ?? translate('sidebar.showMore', { count: hiddenCount });
  return (
    <SidebarMenuRow
      className="group/row flex items-center px-1 py-1 h-8 pl-8"
      data-more-row={foldKey}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => (onToggle ? onToggle() : sidebarStore.toggleIdleExpanded(foldKey))}
    >
      <SidebarMenuAction aria-label={label} className="text-foreground-passive">
        {label}
      </SidebarMenuAction>
    </SidebarMenuRow>
  );
}
