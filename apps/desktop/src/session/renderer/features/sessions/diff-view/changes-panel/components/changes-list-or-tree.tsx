import { type ChangesListViewMode } from '@shared/core/app-settings';
import { Unknown } from '@/components/ui/Unknown';
import { cn } from '@renderer/utils/utils';
import {
  VirtualizedChangesList,
  type VirtualizedChangesListProps,
} from './virtualized-changes-list';
import { VirtualizedChangesTree } from './virtualized-changes-tree';

interface ChangesListOrTreeProps extends VirtualizedChangesListProps {
  /** null: not read yet. */
  viewMode: ChangesListViewMode | null;
}

const PLACEHOLDER_ROWS_MAX = 20;

export function ChangesListOrTree({ viewMode, ...props }: ChangesListOrTreeProps) {
  if (viewMode === null) {
    return (
      <div className={cn('flex h-full flex-col gap-[2px] overflow-hidden py-2 px-1', props.className)}>
        {props.changes.slice(0, PLACEHOLDER_ROWS_MAX).map((change) => (
          <Unknown key={change.path} className="h-[28px] w-full shrink-0" />
        ))}
      </div>
    );
  }
  if (viewMode === 'tree') return <VirtualizedChangesTree {...props} />;
  return <VirtualizedChangesList {...props} />;
}
