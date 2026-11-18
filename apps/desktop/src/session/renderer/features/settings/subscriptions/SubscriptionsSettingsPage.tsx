import { officialServicesEnabled } from '@gugu/core/cloud/optionalServices';
import { SettingsGroup, SettingsPage } from '@/components/settings/SettingsPrimitives';
import { refreshSpendingPower } from '@/lib/billing';
import { PageHeader } from '@renderer/lib/components/page-header';
import { Button } from '@renderer/lib/ui/button';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { GuguSubscriptionRow } from './GuguSubscriptionRow';
import './subscriptions.css';

/** Subscriptions contains only Gugu membership; external model connections live in Models. */
export function SubscriptionsSettingsPage() {
  const { translate } = useSessionMessages();
  return (
    <SettingsPage>
      <PageHeader
        title={translate('subscriptions.title')}
        showTitleInSettings
        aside={<Button variant="outline" size="sm" data-testid="subscriptions-refresh" onClick={refreshSpendingPower}>
          {translate('subscriptions.refresh')}
        </Button>}
      />
      {officialServicesEnabled() ? <SettingsGroup><GuguSubscriptionRow /></SettingsGroup> : null}
    </SettingsPage>
  );
}
