import { AlignJustify, ListTree } from '@/lib/icons'
import { useState } from 'react';
import { Button } from '@renderer/lib/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/lib/ui/tooltip';
import type { ChangesListViewMode } from '@shared/core/app-settings';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { Unknown } from '@/components/ui/Unknown';

interface ChangesViewModeToggleProps {
  /** null: the setting is not read yet. */
  value: ChangesListViewMode | null;
  onChange: (mode: ChangesListViewMode) => void;
  label: string;
}

export function ChangesViewModeToggle({ value, onChange, label }: ChangesViewModeToggleProps) {
  // Not read yet: the button's place, ❌ a button that would switch away from a layout nobody chose.
  if (value === null) return <Unknown className="size-6" />;
  return <KnownChangesViewModeToggle value={value} onChange={onChange} label={label} />;
}

function KnownChangesViewModeToggle({ value, onChange, label }: ChangesViewModeToggleProps & { value: ChangesListViewMode }) {
  const { translate } = useSessionMessages();
  const nextMode: ChangesListViewMode = value === 'flat' ? 'tree' : 'flat';
  const Icon = value === 'flat' ? AlignJustify : ListTree;
  const tooltip = translate(value === 'flat' ? 'changes.switchToTree' : 'changes.switchToFlat');
  const [open, setOpen] = useState(false);

  return (
    <Tooltip
      open={open}
      onOpenChange={(nextOpen, details) => {
        // Keep the tooltip visible after a click so the user can read the
        // updated label that reflects the new view mode.
        if (!nextOpen && details.reason === 'trigger-press') return;
        setOpen(nextOpen);
      }}
    >
      <TooltipTrigger render={
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={() => onChange(nextMode)}
          aria-label={translate('changes.viewModeToggle', { tooltip, label })}
        >
          <Icon className="size-3" />
        </Button>
      } />
      <TooltipContent>{tooltip}</TooltipContent>
    </Tooltip>
  );
}
