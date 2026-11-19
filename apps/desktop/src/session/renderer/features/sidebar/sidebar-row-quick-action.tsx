import type { ReactNode } from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/lib/ui/tooltip';

export function SidebarRowQuickAction({ label, tooltip = label, onClick, children }: {
  label: string;
  tooltip?: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger render={
        <button
          type="button"
          aria-label={label}
          className="flex size-6 items-center justify-center rounded-sm bg-transparent text-foreground-tertiary-passive transition-colors hover:text-foreground active:text-foreground focus-visible:text-foreground [&>svg]:size-3.5"
          onMouseDown={(event) => {
            // A button press should never start dragging the row.
            event.preventDefault();
            event.stopPropagation();
          }}
          onClick={(event) => {
            event.stopPropagation();
            onClick();
          }}
        >
          {children}
        </button>
      } />
      <TooltipContent>{tooltip}</TooltipContent>
    </Tooltip>
  );
}
