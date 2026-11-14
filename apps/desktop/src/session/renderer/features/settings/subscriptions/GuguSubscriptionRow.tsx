import { Unknown } from '@/components/ui/Unknown';
import { readModel, useReadModel } from '@/lib/readModel';
import { useTranslation } from 'react-i18next';
import { publicAssetPath } from '@gugu/core/shared/ui/publicAssets';
import { ArrowUpRight } from '@/lib/icons';
import { useAuth } from '@/store/auth';
import { formatCredits, quotaWindowViews, useSpendingPower } from '@/lib/billing';
import { compareCreditAmounts } from '@gugu/core/billing/creditAmount';
import { creditRatio } from '@/lib/billing/creditGeometry';
import { platform } from '@/platform';
import { GUGU_BILLING_URL, GUGU_TOPUP_URL } from '@/lib/appLinks';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { Button } from '@/components/ui/Button';
import { SubscriptionServiceRow } from './SubscriptionServiceRow';
import './subscriptions.css';

const APP_ICON_URL = publicAssetPath('/assets/app/gugu-icon-small.png');

/** Whether this device already used its free credits for this account (desktop host only). */
const deviceFreeCredits = readModel({
  name: 'deviceFreeCreditsStatus',
  scope: 'account',
  read: async () => (await platform.readDeviceFreeCreditsStatus?.()) ?? null,
  persist: true,
});

export function GuguSubscriptionRow() {
  const { translate, locale } = useSessionMessages();
  const { t } = useTranslation('settings');
  const { user } = useAuth();
  const freeCredits = useReadModel(deviceFreeCredits, user ? [] : null);
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
    <SubscriptionServiceRow
      name={translate('subscriptions.gugu.name')}
      logo={<img className="subscription-gugu-icon" src={APP_ICON_URL} alt="" width={24} height={24} />}
      badge={badge}
      identity={identity}
      scope={<span className="subscription-credit-scope">{translate('subscriptions.gugu.shared')}</span>}
      testId="subscription-row-gugu"
      action={
        <Button variant="ghost" size="sm" nativeButton={false} render={<a href={GUGU_BILLING_URL} target="_blank" rel="noreferrer" />}>
          {translate('subscriptions.gugu.manage')}
          <ArrowUpRight className="ml-1 size-3" />
        </Button>
      }
    >
      <div className="subscription-credit-summary">
        <span className="subscription-credit-label">{translate('subscriptions.gugu.available')}</span>
        <strong className="subscription-credit-value" data-testid="subscription-credits-balance">
          {amount(power && formatCredits(power.spendable))}
        </strong>
        {power && compareCreditAmounts(power.held, 0) > 0 && <p className="subscription-note">{translate('subscriptions.gugu.reserved', { credits: formatCredits(power.held) })}</p>}
      </div>
      <div className="subscription-quota-grid">
        <div className="subscription-quota" data-testid="subscription-period">
          <div className="subscription-quota-label">
            <span>{translate('subscriptions.gugu.period')}</span>
            <strong>
              <span data-testid="subscription-period-credits">{amount(period && formatCredits(period.remaining))}</span>
              {period && <small> / {formatCredits(period.limit)}</small>}
            </strong>
          </div>
          {period && (
            <>
              <div
                className="subscription-meter"
                role="meter"
                aria-label={translate('subscriptions.gugu.period')}
                aria-valuemin={0}
                aria-valuemax={1}
                aria-valuenow={creditRatio(period.remaining, period.limit)}
                aria-valuetext={`${formatCredits(period.remaining)} / ${formatCredits(period.limit)}`}
              >
                <i style={{ width: `${creditRatio(period.remaining, period.limit) * 100}%` }} />
              </div>
              <p>{translate('subscriptions.gugu.resets', { date: date(period.freesAt) })}</p>
            </>
          )}
          {/* Not read yet: the meter's and the reset line's places are kept (❌ inserted later, pushing the row below down). */}
          {unknown && (
            <>
              <Unknown className="mt-2 block h-[3px] w-full" />
              <p><Unknown className="w-32" /></p>
            </>
          )}
        </div>
        <div className="subscription-quota" data-testid="subscription-wallet">
          <div className="subscription-quota-label subscription-wallet-label">
            <span>{translate('subscriptions.gugu.wallet')}</span>
            <strong data-testid="subscription-wallet-credits">{amount(power && formatCredits(power.walletCredits))}</strong>
          </div>
        </div>
      </div>
      {(balanceError || windowsError) && (
        <p className="subscription-error" role="status">
          {translate('subscriptions.unavailable.error', { message: balanceError || windowsError || '' })}
        </p>
      )}
      {deviceFull && !accountError && plan?.tier === 'free' && (
        <p className="subscription-note">{t('usage.na.deviceFull')}</p>
      )}
      <div className="subscription-credit-actions">
        <Button variant="secondary" size="sm" nativeButton={false}
          render={<a href={GUGU_TOPUP_URL} target="_blank" rel="noreferrer" />}
          data-testid="membership-open-web">
          {t('usage.na.openWebBilling')}
          <ArrowUpRight className="ml-1 size-3" />
        </Button>
      </div>
    </SubscriptionServiceRow>
  );
}
