import { officialServicesEnabled } from '@gugu/core/cloud/optionalServices';
import { SettingsPage } from '@/components/settings/SettingsPrimitives';
import { refreshSpendingPower } from '@/lib/billing';
import { Button } from '@/components/ui/Button';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { GuguSubscriptionRow } from './GuguSubscriptionRow';
import './subscriptions.css';

/** Subscriptions contains only Gugu membership; external model connections live in Models. */
export function SubscriptionsSettingsPage() {
  const { translate } = useSessionMessages();
  return (
    <SettingsPage>
      {officialServicesEnabled() ? <GuguSubscriptionRow actions={(
        <Button variant="ghost" size="sm" data-testid="subscriptions-refresh" onClick={refreshSpendingPower}>
          {translate('subscriptions.refresh')}
        </Button>
      )} /> : null}
    </SettingsPage>
  );
}
