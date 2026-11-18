import type { ReactNode } from 'react';
import { Check, type IconComponent } from '@/lib/icons';
import { ResourceMenu } from '@/components/ResourceMenu';
import { ToggleGroup, ToggleGroupItem } from '@renderer/lib/ui/toggle-group';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import type { ResourceContext } from '@shared/resource-actions';

export type MarketCategoryChoice<T extends string> = {
  value: T;
  label: string;
  icon: IconComponent;
};

export function MarketCategoryBar<T extends string>({
  choices, selected, onChange, testIdPrefix,
}: {
  choices: readonly MarketCategoryChoice<T>[];
  selected: T;
  onChange: (value: T) => void;
  testIdPrefix: string;
}) {
  const { translate } = useSessionMessages();
  return (
    <ToggleGroup
      size="sm"
      className="mk-market-categories"
      aria-label={translate('extensions.infoCategory')}
      value={[selected]}
      onValueChange={([value]) => {
        const choice = choices.find((entry) => entry.value === value);
        if (choice) onChange(choice.value);
      }}
    >
      {choices.map(({ value, label, icon: Icon }) => (
        <ToggleGroupItem key={value} value={value} data-testid={`${testIdPrefix}-${value}`}>
          <Icon className="size-4" aria-hidden />
          {label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

export function MarketGrid({ title, count, stale, testId, children }: {
  title: string;
  count: number;
  stale?: string | null;
  testId: string;
  children: ReactNode;
}) {
  return (
    <section className="mk-sec mk-market-section" data-testid={testId}>
      <h3>
        <span>{title}</span>
        <span className="mk-count">{count}</span>
        {stale && <span className="mk-stale" data-testid="extension-market-stale">{stale}</span>}
      </h3>
      <ul className="mk-market-grid" aria-label={title}>{children}</ul>
    </section>
  );
}

export function MarketCard({ testId, name, icon, publisher, category, description, installed, deprecated, onOpen, resource }: {
  testId: string;
  name: string;
  icon: ReactNode;
  publisher?: string;
  category: string;
  description: string;
  installed: boolean;
  deprecated?: boolean;
  onOpen: () => void;
  resource?: ResourceContext;
}) {
  const { translate } = useSessionMessages();
  const card = (
    <button type="button" className="mk-market-card" data-testid={testId} onClick={onOpen}>
      <span className="mk-market-card-header">
        {icon}
        <span className="mk-market-card-identity">
          <span className="mk-market-card-name" data-deprecated={deprecated || undefined} title={name}>{name}</span>
          <span className="mk-market-card-category">{category}</span>
          {(publisher || installed) && (
            <span className="mk-market-card-meta">
              {publisher && <span className="truncate" title={publisher}>{publisher}</span>}
              {installed && (
                <span className="mk-market-card-installed">
                  <Check className="size-3" aria-hidden />
                  {translate('extensions.installedMark')}
                </span>
              )}
            </span>
          )}
        </span>
      </span>
      <span className="mk-market-card-description">{description}</span>
    </button>
  );
  return <li>{resource ? <ResourceMenu resource={resource} allowOnTrigger>{card}</ResourceMenu> : card}</li>;
}
