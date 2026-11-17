import type { GitChange } from '@gugu/session-core/git';
import { GrowingList } from '@gugu/session-ui/react/growing-list';
import { cn } from '@renderer/utils/utils';
import { ChangesListItem } from './changes-list-item';

export interface VirtualizedChangesListProps {
  changes: GitChange[];
  rootPath?: string;
  onSelectChange?: (change: GitChange) => void;
  onDoubleClickChange?: (change: GitChange) => void;
  isSelected?: (path: string) => boolean;
  onToggleSelect?: (path: string) => void;
  onPrefetch?: (change: GitChange) => void;
  activePath?: string;
  className?: string;
}

const ITEM_HEIGHT = 28;

export function VirtualizedChangesList({
  changes,
  rootPath,
  onSelectChange,
  onDoubleClickChange,
  isSelected,
  onToggleSelect,
  onPrefetch,
  activePath,
  className,
}: VirtualizedChangesListProps) {
  return (
    <GrowingList
      className={cn('h-full overflow-y-auto overflow-x-hidden py-2 px-1', className)}
      count={changes.length}
      getKey={(index) => changes[index]!.path}
      gap={2}
      estimateSize={() => ITEM_HEIGHT}
      overscan={5}
      renderLine={(index) => {
        const change = changes[index]!;
        return (
          <ChangesListItem
            change={change}
            rootPath={rootPath}
            isSelected={isSelected?.(change.path)}
            isActive={change.path === activePath}
            onToggleSelect={onToggleSelect}
            style={{ height: ITEM_HEIGHT }}
            onClick={() => onSelectChange?.(change)}
            onDoubleClick={() => onDoubleClickChange?.(change)}
            onMouseEnter={() => onPrefetch?.(change)}
          />
        );
      }}
    />
  );
}
