import type { ReactNode } from 'react';
import { ChevronLeft } from '@/lib/icons';
import { cn } from '@renderer/utils/utils';
import './app-store.css';

export function AppProductBack({ label, onBack, testId }: { label: string; onBack: () => void; testId?: string }) {
  return (
    <button type="button" className="mk-back" onClick={onBack} data-testid={testId}>
      <ChevronLeft className="size-3.5" />
      {label}
    </button>
  );
}

export function AppProductHeader({
  name,
  subtitle,
  publisher,
  deprecated,
  facts,
  factsTestId,
  icon,
  children,
}: {
  name: string;
  subtitle?: string;
  publisher?: string;
  deprecated?: boolean;
  facts: readonly { caption: string; value: ReactNode }[];
  factsTestId?: string;
  icon: ReactNode;
  children: ReactNode;
}) {
  return (
    <>
      {icon}
      <div className="mk-dh-main">
        <h2 className={cn('gg-type-display mk-dh-title', deprecated && 'is-deprecated')}>{name}</h2>
        {subtitle ? <p className="mk-dh-sub">{subtitle}</p> : null}
        {publisher ? <div className="mk-dh-by"><span>{publisher}</span></div> : null}
      </div>
      <dl className="mk-facts" data-testid={factsTestId}>
        {facts.map(({ caption, value }) => (
          <div key={caption}>
            <dt className="order-last">{caption}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      {children}
    </>
  );
}
