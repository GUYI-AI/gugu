import { useMemo } from 'react';
import type { IssueProviderType } from '@shared/issue-providers';
import { isIssueIntegration } from './integration-display';
import { useIntegrationsContext } from './integrations-provider';
import { isProviderUsable, type ProviderContext } from './provider-utils';

export interface UseConnectedIssueProvidersResult {
  connectedProviders: IssueProviderType[];
  hasAnyIssueIntegration: boolean;
  isProviderUsable: (provider: IssueProviderType) => boolean;
  isCheckingConnections: boolean;
}

export function useConnectedIssueProviders(
  context: ProviderContext = {}
): UseConnectedIssueProvidersResult {
  const { connectionStatus, integrations, isCheckingConnections } = useIntegrationsContext();

  // A provider is offered once it is known usable: none while the catalog or the checks are not read yet.
  const connectedProviders = useMemo(
    () =>
      !integrations || !connectionStatus ? [] : integrations
        .filter(isIssueIntegration)
        .map((integration) => integration.id)
        .filter((provider) => isProviderUsable(connectionStatus[provider], context)),
    [connectionStatus, context, integrations]
  );

  const checkUsable = useMemo(
    () => (provider: IssueProviderType) => isProviderUsable(connectionStatus?.[provider], context),
    [connectionStatus, context]
  );

  return {
    connectedProviders,
    hasAnyIssueIntegration: connectedProviders.length > 0,
    isProviderUsable: checkUsable,
    isCheckingConnections,
  };
}
