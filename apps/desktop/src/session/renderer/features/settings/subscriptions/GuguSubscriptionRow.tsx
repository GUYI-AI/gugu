import { Unknown } from '@/components/ui/Unknown';
import { replica, useReplica } from '@/lib/replica';
import { useTranslation } from 'react-i18next';
import { publicAssetPath } from '@gugu/core/shared/ui/publicAssets';
import { ArrowUpRight } from '@/lib/icons';
import { useAuth } from '@/store/auth';
import { formatCredits, quotaWindowViews, useSpendingPower } from '@/lib/billing';
import { compareCreditAmounts } from '@gugu/core/billing/creditAmount';
import { creditRatio } from '@/lib/billing/creditGeometry';
import { platform } from '@/platform';
import { billingLinksAvailable, GUGU_BILLING_URL, GUGU_TOPUP_URL } from '@/lib/appLinks';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { Button } from '@/components/ui/Button';
import type { ReactNode } from 'react';
import { SettingsGroup, SettingsNote, SettingsRow } from '@/components/settings/SettingsPrimitives';
import './subscriptions.css';

const APP_ICON_URL = publicAssetPath('/assets/app/gugu-icon-small.png');

/** Whether this device already used its free credits for this account (desktop host only). */
const deviceFreeCredits = replica({
  name: 'deviceFreeCreditsStatus',
  scope: 'account',
  networkMode: 'always',
  read: async () => (await platform.readDeviceFreeCreditsStatus?.()) ?? null,
  persist: { maxBytes: 256, maxEntries: 1 },
});

/** Gugu membership: the plan on a summary surface, then its credits as rows. `actions` sit beside top-up (the Settings page's refresh). */
export function GuguSubscriptionRow({ actions }: { actions?: ReactNode } = {}) {
  const { translate, locale } = useSessionMessages();
  const { t } = useTranslation('settings');
  const { user } = useAuth();
  const freeCredits = useReplica(deviceFreeCredits, user ? [] : null);
  const deviceFull = freeCredits.state === 'value' && freeCredits.value === 'device_full';
  const { state, power, windows, balanceError, windowsError, membership: plan } = useSpendingPower(user);
  const unknown = state === 'unknown';
  // 读到之前每个数位画同尺寸的占位;只有读到而这一项取不到时才写「—」。
  const amount = (value: string | null) => (unknown ? <Unknown className="w-12" /> : value ?? '—');
  const accountError = balanceError || windowsError;
  const date = (value: Date) =>
    new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'short', day: 'numeric' }).format(value);
  const period = windows ? quotaWindowViews(windows).period : null;
  const badge = plan ? plan.tier[0].toUpperCase() + plan.tier.slice(1) : undefined;
  const identity = !user
    ? translate('subscriptions.gugu.signIn')
    : accountError
      ? translate('subscriptions.unavailable.error', { message: accountError })
      : unknown
        ? <Unknown className="w-32" />
        : plan
          ? plan.expiresAt
            ? translate('subscriptions.gugu.expires', { date: date(plan.expiresAt) })
            : translate('subscriptions.gugu.noExpiry')
          : translate('subscriptions.payer.unknown');
  return (
    <div className="contents" data-testid="subscription-row-gugu">
      <SettingsGroup presentation="summary">
        <SettingsRow
          leading={<img className="subscription-gugu-icon" src={APP_ICON_URL} alt="" width={24} height={24} />}
          title={<>{translate('subscriptions.gugu.name')}{badge && <span className="subscription-plan-badge">{badge}</span>}</>}
          description={<>{identity} · {translate('subscriptions.gugu.shared')}</>}
          control={billingLinksAvailable() ? (
            <Button variant="secondary" size="sm" nativeButton={false} render={<a href={GUGU_BILLING_URL} target="_blank" rel="noreferrer" />}>
              {translate('subscriptions.gugu.manage')}<ArrowUpRight className="ml-1 size-3" />
            </Button>
          ) : undefined}
        />
      </SettingsGroup>
      <SettingsGroup footer={accountError
        ? <SettingsNote tone="danger" role="status">{translate('subscriptions.unavailable.error', { message: accountError })}</SettingsNote>
        : deviceFull && plan?.tier === 'free' ? <SettingsNote>{t('usage.na.deviceFull')}</SettingsNote> : undefined}>
        <SettingsRow title={translate('subscriptions.gugu.available')}
          description={power && compareCreditAmounts(power.held, 0) > 0 ? translate('subscriptions.gugu.reserved', { credits: formatCredits(power.held) }) : undefined}
          control={<span className="subscription-figure" data-testid="subscription-credits-balance">{amount(power && formatCredits(power.spendable))}</span>} />
        <SettingsRow title={translate('subscriptions.gugu.period')} data-testid="subscription-period"
          description={period ? <>
            <span className="subscription-meter" role="meter" aria-label={translate('subscriptions.gugu.period')}
              aria-valuemin={0} aria-valuemax={1} aria-valuenow={creditRatio(period.remaining, period.limit)}
              aria-valuetext={`${formatCredits(period.remaining)} / ${formatCredits(period.limit)}`}>
              <i style={{ width: `${creditRatio(period.remaining, period.limit) * 100}%` }} />
            </span>
            {translate('subscriptions.gugu.resets', { date: date(period.freesAt) })}
          </> : unknown ? <Unknown className="w-32" /> : undefined}
          control={<span className="subscription-figure"><span data-testid="subscription-period-credits">{amount(period && formatCredits(period.remaining))}</span>
            {period && <small> / {formatCredits(period.limit)}</small>}</span>} />
        <SettingsRow title={translate('subscriptions.gugu.wallet')} data-testid="subscription-wallet"
          control={<span className="subscription-figure" data-testid="subscription-wallet-credits">{amount(power && formatCredits(power.walletCredits))}</span>} />
        {(billingLinksAvailable() || actions) && <SettingsRow
          control={<>{actions}{billingLinksAvailable() && <Button variant="secondary" size="sm" nativeButton={false}
            render={<a href={GUGU_TOPUP_URL} target="_blank" rel="noreferrer" />} data-testid="membership-open-web">
            {t('usage.na.openWebBilling')}<ArrowUpRight className="ml-1 size-3" />
          </Button>}</>} />}
      </SettingsGroup>
    </div>
  );
}
