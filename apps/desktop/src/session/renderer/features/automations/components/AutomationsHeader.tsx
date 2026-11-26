import type { RefObject } from 'react';
import { Plus } from '@/lib/icons'
import { Button } from '@renderer/lib/ui/button';
import { SearchInput } from '@renderer/lib/ui/search-input';
import { useSessionMessages } from '@renderer/localization/use-session-messages';

interface AutomationsHeaderProps {
  searchInputRef: RefObject<HTMLInputElement | null>;
  search: string;
  onSearchChange: (value: string) => void;
  onNewAutomation: () => void;
}

export function AutomationsHeader({
  searchInputRef,
  search,
  onSearchChange,
  onNewAutomation,
}: AutomationsHeaderProps) {
  const { translate } = useSessionMessages();
  return (
    <div className="flex min-w-0 items-center justify-between gap-3 [-webkit-app-region:no-drag]">
      <SearchInput
        ref={searchInputRef}
        containerClassName="w-full max-w-72"
        placeholder={translate('automations.searchPlaceholder')}
        value={search}
        onChange={(event) => onSearchChange(event.target.value)}
      />
      <Button className="shrink-0 whitespace-nowrap" onClick={onNewAutomation}>
        <Plus className="size-3.5" />
        {translate('automations.new')}
      </Button>
    </div>
  );
}
