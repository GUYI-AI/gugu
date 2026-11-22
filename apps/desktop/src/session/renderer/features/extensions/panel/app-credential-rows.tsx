import { useState } from 'react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@renderer/lib/ui/select';
import { rpc } from '@renderer/lib/ipc';
import { log } from '@renderer/utils/logger';
import { replica, useReplica } from '@/lib/replica';
import { siteHosts } from '@shared/extensions/app-credentials';
import type { SessionTranslate } from '../extension-consent';

const NONE = '__none__';
// This computer's App credential picks, read by main from its password vault; read again after a pick.
const appCredentialStates = replica({ name: 'appCredentialStates', scope: 'device',
  read: async (_owner: string, extensionId: string) => {
    const result = await rpc.extensions.appCredentials({ extensionId });
    if (result.success && result.data) return result.data;
    const reason = result.success ? 'no answer' : result.error;
    log.warn('Could not read the App\'s saved credentials', reason);
    throw new Error(reason);
  } });

/**
 * The App's permissions, API 61: per website it declares a credential for, which saved one it uses on this computer.
 * The list comes from the password vault through main; no value ever comes here.
 */
export function AppCredentialRows({ extensionId, hosts, translate, disabled }: {
  extensionId: string; hosts: readonly string[]; translate: SessionTranslate; disabled: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const reading = useReplica(appCredentialStates, [extensionId]);
  async function pick(site: string, credentialId: string | null) {
    setBusy(true);
    try {
      const result = await rpc.extensions.setAppCredential({ extensionId, site, credentialId });
      if (!result.success) log.warn('Could not pick the App\'s saved credential', result.error);
      await appCredentialStates.refresh(extensionId);
    } finally { setBusy(false); }
  }
  if (reading.state === 'unknown') return null; // not read yet: no rows rather than empty ones
  if (reading.state === 'error') return <div className="mg-row mk-pl mg-permission" role="alert" data-testid="app-credential-error">{translate('extensions.credentialUnavailable')}</div>;
  return <>{reading.value.map((state) => (
    <div className="mg-row mk-pl mg-permission" key={state.site} data-testid={`app-credential-${state.site}`}>
      <span>{translate('extensions.permissionsCredential', { site: state.site, hosts: siteHosts(hosts, state.site).join(', ') })}</span>
      {state.choices.length ? (
        <Select value={state.chosen?.id ?? NONE} disabled={disabled || busy} onValueChange={(next) => void pick(state.site, next === NONE ? null : String(next))}>
          <SelectTrigger data-testid={`app-credential-${state.site}-pick`} aria-label={translate('extensions.credentialWhich')}>
            <SelectValue>{state.chosen?.label ?? translate('extensions.credentialNone')}</SelectValue>
          </SelectTrigger>
          <SelectContent align="start">
            {state.choices.map((choice) => (
              <SelectItem key={choice.id} value={choice.id}>
                <span className="flex flex-col"><span>{choice.label}</span><span className="text-xs text-muted-foreground">{choice.detail}</span></span>
              </SelectItem>
            ))}
            <SelectItem value={NONE}>{translate('extensions.credentialNone')}</SelectItem>
          </SelectContent>
        </Select>
      ) : <small data-testid={`app-credential-${state.site}-empty`}>{translate('extensions.credentialEmpty', { site: state.site })}</small>}
    </div>
  ))}</>;
}
