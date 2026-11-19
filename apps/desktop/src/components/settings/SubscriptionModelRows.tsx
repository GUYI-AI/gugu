import type { HarnessConnection } from '@gugu/session-core/workspace-server/agent-config';
import type { AgentPayload } from '@shared/core/agents/agent-payload';
import { Link, Trash2 } from '@/lib/icons';
import { SettingsNote, SettingsRow } from './SettingsPrimitives';
import { Unknown } from '@/components/ui/Unknown';
import { Button } from '@renderer/lib/ui/button';
import { AppIcon } from '@renderer/lib/components/app-icon';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { useConnectionDetails } from '@renderer/features/settings/subscriptions/listed-connections';
import { useAgentAuthStatus } from '@renderer/lib/stores/use-agent-auth-status';
import { errorText } from '@renderer/features/settings/subscriptions/subscription-queries';
import { refreshFailure } from '@/lib/replica';

export function SubscriptionModelRows({ agent, machine, connections, busy, onSignIn, onAddAccount, onTest, onRemove, onRetry, error }: {
  agent: AgentPayload; machine: string | null; connections: HarnessConnection[] | undefined; busy: boolean;
  onSignIn: (id: string) => void; onAddAccount: () => void; onTest: (id: string) => void; onRemove: (id: string) => void; onRetry: () => void; error?: string | null;
}) {
  const { translate } = useSessionMessages();
  return <>
    {error && <SettingsRow description={<SettingsNote tone="danger" role="alert">{error}</SettingsNote>} control={<Button size="sm" variant="outline" onClick={onRetry}>{translate('common.retry')}</Button>} />}
    {!error && !connections && <SettingsRow control={<Unknown className="h-4 w-32" />} />}
    {connections?.map(connection => <SubscriptionModelRow key={connection.id} {...{ agent, machine, connection, busy, onSignIn, onAddAccount, onTest, onRemove }} />)}
  </>;
}

function SubscriptionModelRow({ agent, machine, connection, busy, onSignIn, onAddAccount, onTest, onRemove }: Omit<Parameters<typeof SubscriptionModelRows>[0], 'connections' | 'error' | 'onRetry'> & { connection: HarnessConnection }) {
  const { translate } = useSessionMessages();
  const reading = useConnectionDetails(machine, agent.id, connection.id);
  const details = reading.state === 'value' ? reading.value : undefined;
  const failed = refreshFailure(reading);
  const { auth } = useAgentAuthStatus(agent.id, undefined, { machine, probe: false });
  const status = connection.current && auth?.status.kind === 'unauthenticated' && auth.status.reason === 'expired' ? auth.status : details?.status;
  const expired = status?.kind === 'unauthenticated' && status.reason === 'expired';
  const source = translate(agent.id === 'claude' ? 'customModels.claudeAccount' : 'customModels.codexAccount');
  const plan = details?.plan?.plan;
  if (connection.kind === 'native' && (details?.plan?.payer === 'api-key' || details?.plan?.payer === 'custom-endpoint')) return null;
  const brand = agent.id === 'claude' ? 'Claude' : 'ChatGPT';
  const name = connection.name || (plan ? plan.toLowerCase().includes(brand.toLowerCase()) ? plan : `${brand} ${plan}` : source);
  return <SettingsRow data-subscription-model={`${agent.id}:${connection.id}`} leading={<AppIcon id={agent.id} size={20} />}
    title={name} description={<>{source}{failed ? <span role="alert" className="subscription-error block">{translate('customModels.statusReadFailed')}</span> : null}</>}
    control={<div className="flex items-center gap-2">
      {expired ? <>
        <span className="gg-model-expired">{translate('subscriptions.connections.expired')}</span>
        {connection.kind === 'native' ? (
          <Button size="sm" variant="outline" disabled={busy} data-testid={`model-add-account-${agent.id}`} onClick={onAddAccount}>
            {translate('subscriptions.connections.addAndSignIn')}
          </Button>
        ) : (
          <Button size="sm" variant="outline" disabled={busy} data-testid={`model-sign-in-${connection.id}`} onClick={() => onSignIn(connection.id)}>
            {translate('subscriptions.connections.signInAgain')}
          </Button>
        )}
      </> : <Button className="gg-model-icon-button" size="icon" variant="ghost" disabled={busy} aria-label={translate('customModels.test')} data-testid={`model-test-${connection.id}`} onClick={() => onTest(connection.id)}><Link className="size-4" /></Button>}
      {connection.kind !== 'native' && <Button className="gg-model-icon-button" size="icon" variant="ghost" disabled={busy} aria-label={translate('customModels.remove')} data-testid={`model-remove-${connection.id}`} onClick={() => onRemove(connection.id)}><Trash2 className="size-4" /></Button>}
    </div>} />;
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
