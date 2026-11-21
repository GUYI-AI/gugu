import type { HarnessConnection } from '@gugu/session-core/workspace-server/agent-config';
import type { AgentPayload } from '@shared/core/agents/agent-payload';
import { Trash2 } from '@/lib/icons';
import { SettingsNote, SettingsRow } from './SettingsPrimitives';
import { Unknown } from '@/components/ui/Unknown';
import { Button } from '@renderer/lib/ui/button';
import { AppIcon } from '@renderer/lib/components/app-icon';
import type { ReactNode } from 'react';
import { CodingPlanGroup } from './CodingPlanGroup';
import { InlineConnectionName } from './InlineConnectionName';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { useConnectionDetails } from '@renderer/features/settings/subscriptions/listed-connections';
import { useAgentAuthStatus } from '@renderer/lib/stores/use-agent-auth-status';
import { errorText } from '@renderer/features/settings/subscriptions/subscription-queries';
import { refreshFailure } from '@/lib/replica';
import { SubscriptionModelQuota } from './SubscriptionModelQuota';

export function SubscriptionModelRows({ agent, machine, connections, busy, onSignIn, onRemove, onSelect, onRename, onRetry, error, notice }: {
  agent: AgentPayload; machine: string | null; connections: HarnessConnection[] | undefined; busy: boolean;
  onSignIn: (id: string) => void; onRemove: (id: string) => void; onSelect: (id: string) => void; onRename: (id: string, name: string) => Promise<void>; onRetry: () => void; error?: string | null; notice?: ReactNode;
}) {
  const { translate } = useSessionMessages();
  const subscriptions = connections;
  if (subscriptions?.length === 0 && !error) return null;
  return <CodingPlanGroup id={agent.id === 'codex' ? 'chatgpt-subscription' : 'claude-subscription'} name={agent.id === 'codex' ? 'ChatGPT' : 'Claude'} icon={<AppIcon id={agent.id} size={20} />}>
    {notice}
    {error && <SettingsRow description={<SettingsNote tone="danger" role="alert">{error}</SettingsNote>} control={<Button size="sm" variant="outline" onClick={onRetry}>{translate('common.retry')}</Button>} />}
    {!error && !connections && <SettingsRow control={<Unknown className="h-4 w-32" />} />}
    {subscriptions?.map(connection => <SubscriptionModelRow key={connection.id} multiple={(subscriptions?.length ?? 0) > 1} {...{ agent, machine, connection, busy, onSignIn, onRemove, onSelect, onRename }} />)}
  </CodingPlanGroup>;
}

function SubscriptionModelRow({ agent, machine, connection, busy, onSignIn, onRemove, onSelect, onRename, multiple }: Omit<Parameters<typeof SubscriptionModelRows>[0], 'connections' | 'error' | 'onRetry' | 'notice'> & { connection: HarnessConnection; multiple: boolean }) {
  const { translate } = useSessionMessages();
  const reading = useConnectionDetails(machine, agent.id, connection.id);
  const details = reading.state === 'value' ? reading.value : undefined;
  const failed = refreshFailure(reading);
  const { auth } = useAgentAuthStatus(agent.id, undefined, { machine, probe: false });
  const status = connection.current && auth?.status.kind === 'unauthenticated' && auth.status.reason === 'expired' ? auth.status : details?.status;
  const expired = status?.kind === 'unauthenticated' && status.reason === 'expired';
  const source = translate(agent.id === 'claude' ? 'customModels.claudeAccount' : 'customModels.codexAccount');
  const plan = details?.plan?.plan;
  const brand = agent.id === 'claude' ? 'Claude' : 'ChatGPT';
  const name = connection.name || (connection.kind === 'native' ? translate('subscriptions.connections.existing') : plan ? plan.toLowerCase().includes(brand.toLowerCase()) ? plan : `${brand} ${plan}` : source);
  const subscription = status?.kind === 'authenticated' && details?.plan?.payer !== 'api-key' && details?.plan?.payer !== 'custom-endpoint';
  return <SubscriptionModelQuota machine={machine} provider={agent.id === 'claude' ? 'claude' : 'codex'} connectionId={connection.id}
    account={status?.kind === 'authenticated' ? status.account : undefined} plan={plan} enabled={subscription}>
  <SettingsRow data-subscription-model={`${agent.id}:${connection.id}`}
    title={<InlineConnectionName name={name} busy={busy} onRename={name => onRename(connection.id, name)} />} description={failed ? <span role="alert" className="subscription-error block">{translate('customModels.statusReadFailed')}</span> : undefined}
    control={<div className="gg-model-subscription-controls">
      <div className="gg-model-subscription-usage">
      {(agent.id === 'claude' || agent.id === 'codex') && <SubscriptionModelQuota machine={machine} provider={agent.id} connectionId={connection.id} account={connection.name}
        enabled={subscription} inlineOnly />}
      {status?.kind === 'unauthenticated' &&
        <span className={expired ? 'gg-model-expired' : 'text-xs text-foreground-muted'}>{translate(expired ? 'subscriptions.connections.expired' : 'subscriptions.connections.signedOut')}</span>}
      {connection.kind === 'native' && status?.kind === 'authenticated' &&
        <span className="text-xs text-foreground-muted">{translate('subscriptions.connections.signedIn')}</span>}
      {!(status?.kind === 'authenticated' && status.credentialKind === 'api-key') && (
          <Button size="sm" variant="outline" disabled={busy} data-testid={`model-sign-in-${connection.id}`} onClick={() => onSignIn(connection.id)}>
            {translate('subscriptions.connections.signInAgain')}
          </Button>
      )}
      </div>
      <div className="gg-model-subscription-status">
        {(multiple || connection.kind === 'native') && (connection.current
          ? <span className="text-xs text-foreground-muted" data-testid={`model-current-${connection.id}`}>{translate('subscriptions.connections.current')}</span>
          : <Button size="sm" variant="outline" disabled={busy} data-testid={`model-switch-${connection.id}`} onClick={() => onSelect(connection.id)}>{translate('subscriptions.connections.switchAction')}</Button>)}
      </div>
      <div className="gg-model-subscription-remove">
      {connection.kind !== 'native' && <Button className="gg-model-icon-button" size="icon" variant="ghost" disabled={busy} aria-label={translate('customModels.remove')} data-testid={`model-remove-${connection.id}`} onClick={() => onRemove(connection.id)}><Trash2 className="size-4" /></Button>}
      </div>
    </div>} /></SubscriptionModelQuota>;
}

/** This view is rendered by the existing account ConnectionForm and its existing create/login operation. */
export function SubscriptionAccountField({ agent, machine, connectionId, creating, failure, onLogin, onSave, onCancel }: {
  agent: AgentPayload; machine: string | null; connectionId?: string; creating: boolean; failure: string | null;
  onLogin: () => void; onSave: () => void; onCancel: () => void;
}) {
  const { translate } = useSessionMessages();
  const details = useConnectionDetails(machine, agent.id, connectionId);
  const pending = details.state === 'unknown';
  const failed = refreshFailure(details);
  const status = details.state === 'value' ? details.value.status : undefined;
  const signedIn = status?.kind === 'authenticated';
  return <div className="subscription-connection-form">
    <label>{translate('customModels.account')}<span className="flex items-center gap-2">
      <input className="h-9 min-w-0 flex-1 rounded-md border bg-muted px-3 text-sm" readOnly aria-label={translate('customModels.account')}
        value={signedIn ? status.account || translate('subscriptions.connections.account') : translate('customModels.notSignedIn')} />
      <Button type="button" variant="outline" size="sm" disabled={creating || (!!connectionId && pending)} onClick={onLogin}>{translate('subscriptions.connections.signIn')}</Button>
    </span></label>
    {failure && <SettingsNote tone="danger" role="alert">{failure}</SettingsNote>}
    {connectionId && failed && <SettingsNote tone="danger" role="alert">{errorText(failed)}</SettingsNote>}
    {connectionId && pending && <Unknown className="h-3 w-32" />}
    <div className="flex justify-end gap-2 pt-2">
      <Button type="button" variant="outline" disabled={creating} onClick={onCancel}>{translate('common.cancel')}</Button>
      <Button type="button" data-testid="subscription-model-save" disabled={!signedIn || creating} onClick={onSave}>{translate('common.save')}</Button>
    </div>
  </div>;
}
