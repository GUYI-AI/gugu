import type { RefObject } from 'react';
import { Plus } from '@/lib/icons'
import { PageHeader } from '@renderer/lib/components/page-header';
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
    <PageHeader
      title={translate('automations.title')}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <SearchInput
            ref={searchInputRef}
            placeholder={translate('automations.searchPlaceholder')}
            value={search}
            onChange={(event) => onSearchChange(event.target.value)}
          />
        </div>
        <Button
          className="shrink-0 whitespace-nowrap"
          onClick={onNewAutomation}
        >
          <Plus className="h-3.5 w-3.5" />
          {translate('automations.new')}
        </Button>
      </div>
    </PageHeader>
  );
}
