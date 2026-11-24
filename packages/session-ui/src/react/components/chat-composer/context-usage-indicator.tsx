import type { ReactNode } from 'react';
import { ContextThresholdMenu, type ContextThreshold } from './context-threshold';
import { Button } from '@session-ui/react/primitives/button';
import { Popover } from '@session-ui/react/primitives/popover';
import { cx } from '@session-ui/styles/utilities/cx';
import * as styles from './chat-composer.css';
import { useMessages } from '../../localization/message-provider';
import { formatTokenCount } from '@gugu/session-shared/format';

// ── Data type ─────────────────────────────────────────────────────────────────

export interface ContextUsage {
  used: number;
  size: number;
  cost?: { amount: number; currency: string } | null;
  /** Where the current session gets billed. Unknown/subscription must hide provider currency. */
  costSource: 'platform' | 'api-key' | 'subscription' | 'unknown';
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** 千/兆的进位判据与压缩行、模型 tooltip 同一份(session-shared);这里只是沿用旧名。 */
export function formatTokens(n: number): string {
  return formatTokenCount(n);
}

export function providerCostForRoute(
  usage: Pick<ContextUsage, 'cost' | 'costSource'>
): { amount: number; currency: string } | null {
  return usage.costSource === 'api-key' ? (usage.cost ?? null) : null;
}

function formatCost(cost: { amount: number; currency: string }, locale: string): string {
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: cost.currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 4,
    }).format(cost.amount);
  } catch {
    return `${cost.amount} ${cost.currency}`;
  }
}

export function ContextUsageIndicator({
  usage,
  threshold,
  harness,
  disabled,
}: {
  usage?: ContextUsage | null;
  threshold?: ContextThreshold;
  harness?: { name: string; icon?: ReactNode };
  disabled?: boolean;
}) {
  const { locale, translate } = useMessages();
  const size = threshold?.value ?? usage?.size ?? threshold?.maximum ?? 0;
  const fraction = usage && size > 0 ? Math.min(1, Math.max(0, usage.used / size)) : 0;
  const pct = Math.round(fraction * 1000) / 10;
  const providerCost = usage && providerCostForRoute(usage);
  const title = usage ? translate('composer.contextWindowUsed', { percent: pct }) : translate('composer.contextUsage');
  const triggerLabel = harness ? `${harness.name} · ${title}` : title;

  return (
    <Popover.Root>
      <Popover.Trigger
        render={
          <Button
            variant="ghost"
            size="sm"
            className={styles.usageTrigger}
            disabled={disabled}
            aria-label={triggerLabel}
            title={triggerLabel}
          >
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true"
              className={cx(styles.usageRing, fraction >= 0.9 && styles.usageRingWarn)}>
              <circle className={styles.usageRingTrack} cx="9" cy="9" r="7" strokeWidth="2" />
              {fraction > 0 && <circle cx="9" cy="9" r="7" pathLength="100" stroke="currentColor"
                strokeWidth="2" strokeLinecap="round" strokeDasharray={`${fraction * 100} 100`}
                transform="rotate(-90 9 9)" />}
            </svg>
          </Button>
        }
      />
      <Popover.Content align="end" side="top">
        <Popover.Header className={styles.usageHeader}>
          <Popover.Title>{translate('composer.contextUsage')}</Popover.Title>
          {harness && <span className={styles.usageHarness}>{harness.icon}{harness.name}</span>}
        </Popover.Header>
        <div className={styles.usagePopoverBody}>
          <div className={styles.usageStatsRow}>
            <span className={styles.usagePercent}>{usage ? `${pct.toFixed(1)}%` : '—'}</span>
            <span className={styles.usageTokenCount}>
              {usage
                ? translate('composer.contextTokensUsed', { used: formatTokens(usage.used), size: formatTokens(size) })
                : formatTokens(size)}
            </span>
          </div>
          <div className={styles.usageBarTrack} aria-hidden="true">
            <div
              className={cx(styles.usageBarFill, fraction >= 0.9 && styles.usageBarFillWarn)}
              style={{ width: `${pct}%` }}
            />
          </div>
          {providerCost ? (
            <div className={styles.usageCostRow}>
              {translate('composer.cost', { cost: formatCost(providerCost, locale) })}
            </div>
          ) : null}
          {size > 0 && <div className={styles.contextUsageFooter}>
            {threshold?.set ? <ContextThresholdMenu threshold={threshold}
              label={translate('composer.contextThresholdValue', { size: formatTokens(threshold.value ?? threshold.maximum) })} />
              : <span title={threshold?.unsupported ? translate('composer.contextThresholdUnsupported') : undefined}>
                {translate('composer.contextThresholdValue', { size: formatTokens(size) })}
              </span>}
          </div>}
        </div>
      </Popover.Content>
    </Popover.Root>
  );
}
