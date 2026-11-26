import { useState } from 'react';
import type { ManagedAgentVersions } from '@shared/core/agents/managed-versions';
import { SettingsRow } from '@/components/settings/SettingsPrimitives';
import { replicaAccount, useReplica, retryOf } from '@/lib/replica';
import { messageForUser } from '@/lib/userFacingError';
import { rendererLogger } from '@/lib/log';
import { useLibraryHost } from '@renderer/features/library/library-host';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { useConfirm } from '@renderer/lib/modal/modal-surface';
import { toast } from '@renderer/lib/hooks/use-toast';
import { Button } from '@renderer/lib/ui/button';
import { Checkbox } from '@renderer/lib/ui/checkbox';
import { Badge } from '@renderer/lib/ui/badge';
import { cleanManagedVersions, managedVersions } from './managed-versions-model';

const displayVersion = (version: string) => `v${version.replace(/^v/, '')}`;

export function ManagedVersionsRow({ agentId, name, disabled }: { agentId: string; name: string; disabled: boolean }) {
  const host = useLibraryHost();
  const deviceId = host.remote?.deviceId ?? null;
  const { translate } = useSessionMessages();
  const reading = useReplica(managedVersions, [deviceId, agentId], { read: !disabled && host.remote?.online !== false });
  if (reading.state === 'unknown') return <SettingsRow title={translate('agentsPage.oldVersions')} data-testid="managed-old-versions" description={<span aria-busy="true">…</span>} />;
  if (reading.state === 'error') return <SettingsRow title={translate('agentsPage.oldVersions')} data-testid="managed-old-versions"
    description={translate('agentsPage.oldVersionsReadFailed')}
    control={<Button size="sm" variant="outline" disabled={disabled || host.remote?.online === false} onClick={retryOf(reading)}>{translate('common.retry')}</Button>} />;
  return <KnownManagedVersionsRow agentId={agentId} name={name} disabled={disabled} data={reading.value} readFailed={!!reading.error} retry={retryOf(reading)} />;
}

function KnownManagedVersionsRow({ agentId, name, disabled, data, readFailed, retry }: { agentId: string; name: string; disabled: boolean; data: ManagedAgentVersions; readFailed: boolean; retry: (() => void) | undefined }) {
  const host = useLibraryHost();
  const deviceId = host.remote?.deviceId ?? null;
  const { translate } = useSessionMessages();
  const old = data.versions.filter(version => version !== data.currentVersion);
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const chosen = selected.filter(version => old.includes(version));
  const confirm = useConfirm();
  const clean = () => {
    const owner = replicaAccount().id;
    const versions = [...chosen];
    if (!owner || versions.length === 0 || readFailed) return;
    confirm({
      title: translate('agentsPage.oldVersionsConfirm'),
      confirmLabel: translate('agentsPage.oldVersionsCleanAction'), variant: 'destructive',
      description: <ul className="space-y-1">{versions.map(version => <li key={version}>{translate('agentsPage.oldVersionsDescription', { name, version: displayVersion(version) })}</li>)}</ul>,
      onSuccess: () => {
        if (replicaAccount().id !== owner) return;
        setBusy(true);
        void cleanManagedVersions(deviceId, agentId, versions).then(result => {
          if (replicaAccount().id !== owner) return;
          setSelected(previous => previous.filter(version => !result.removed.includes(version)));
          if (result.failed.length) {
            rendererLogger('agents/managed-versions').error({ failed: result.failed }, 'selected version cleanup incomplete');
            toast({ title: translate('agentsPage.oldVersionsPartialFailure'), variant: 'destructive' });
          } else { setOpen(false); toast({ title: translate('agentsPage.oldVersionsCleaned') }); }
        }).catch(error => {
          if (replicaAccount().id === owner) {
            toast({ title: translate('agentsPage.oldVersionsCleanFailed'), description: messageForUser(error), variant: 'destructive' });
            void managedVersions.refresh(deviceId, agentId);
          }
        }).finally(() => setBusy(false));
      },
    });
  };
  const unavailable = disabled || busy;
  return <SettingsRow title={translate('agentsPage.oldVersions')} data-testid="managed-old-versions"
    description={readFailed ? translate('agentsPage.oldVersionsReadFailed') : !old.length ? translate('agentsPage.oldVersionsNoOld') : !open ? old.map(displayVersion).join('、') : undefined}
    control={readFailed ? <Button size="sm" variant="outline" disabled={unavailable} onClick={retry}>{translate('common.retry')}</Button>
      : !open && old.length ? <Button size="sm" variant="outline" disabled={unavailable} onClick={() => { setSelected([]); setOpen(true); void managedVersions.refresh(deviceId, agentId); }}>{translate('agentsPage.oldVersionsClean')}</Button> : undefined}>
    {open && old.length > 0 && <div className="space-y-3">
      <div className="max-h-48 space-y-2 overflow-y-auto">{[data.currentVersion, ...old].map(version => <label key={version} className="flex items-center gap-2 text-sm">
        <Checkbox disabled={unavailable || version === data.currentVersion || readFailed} checked={version !== data.currentVersion && chosen.includes(version)}
          onCheckedChange={checked => setSelected(previous => checked ? [...previous.filter(item => item !== version), version] : previous.filter(item => item !== version))} />
        <span className="min-w-0 break-all">{displayVersion(version)}</span>
        {version === data.currentVersion && <Badge variant="secondary">{translate('agentsPage.oldVersionsCurrent')}</Badge>}
      </label>)}</div>
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="outline" disabled={busy} onClick={() => { setOpen(false); setSelected([]); }}>{translate('common.cancel')}</Button>
        <Button size="sm" disabled={unavailable || readFailed || chosen.length === 0} onClick={clean}>{translate('agentsPage.oldVersionsCleanAction')}</Button>
      </div>
    </div>}
  </SettingsRow>;
}
