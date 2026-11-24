import { useState } from 'react';
import type { AppCredentialChooseAsk } from '@shared/extensions/app-credentials';
import { rpc } from '@renderer/lib/ipc';
import type { BaseModalProps } from '@renderer/lib/modal/modal-provider';
import { Button } from '@renderer/lib/ui/button';
import { DialogContentArea, DialogFooter, DialogHeader, DialogTitle } from '@renderer/lib/ui/dialog';
import { Input } from '@renderer/lib/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@renderer/lib/ui/select';
import { useReplica } from '@/lib/replica';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { appCredentialStates } from './app-credential-rows';

/**
 * API 64 `gugu.credentials.choose(site)`: the person's own place to give an App a credential, opened from the App's page.
 * One of their saved ones for that website, or a new one saved here (as Settings › Passwords would) and picked for the
 * App; the App's declaration says what to save and where to make it. The value goes to the vault and nowhere else.
 */
export function AppCredentialDialog({ ask, onSuccess, onClose }: BaseModalProps<void> & { ask: AppCredentialChooseAsk }) {
  const { translate } = useSessionMessages();
  const reading = useReplica(appCredentialStates, [ask.extensionId]);
  const state = reading.state === 'value' ? reading.value.find((entry) => entry.site === ask.site) : undefined;
  const [picked, setPicked] = useState<string | null>(null);
  const [name, setName] = useState(`${ask.appName} · ${ask.site}`);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const choice = picked ?? state?.chosen?.id ?? state?.choices[0]?.id ?? null;

  async function run(call: () => Promise<{ success: boolean; error?: string }>) {
    setBusy(true); setError('');
    try {
      const result = await call();
      if (!result.success) { setError(result.error ?? translate('extensions.credentialUnavailable')); return; }
      await appCredentialStates.refresh(ask.extensionId);
      onSuccess();
    } finally { setBusy(false); }
  }
  const use = () => choice && run(() => rpc.extensions.setAppCredential({ extensionId: ask.extensionId, site: ask.site, credentialId: choice }));
  const save = () => run(() => rpc.extensions.saveAppCredential({ extensionId: ask.extensionId, site: ask.site, name, value }));

  return (
    <>
      <DialogHeader>
        <DialogTitle>{translate('extensions.credentialChooseTitle', { app: ask.appName, site: ask.site })}</DialogTitle>
      </DialogHeader>
      <DialogContentArea className="flex flex-col gap-4 pt-0" data-testid="app-credential-dialog">
        {ask.hint || ask.help ? (
          <p className="text-sm text-foreground">
            {ask.hint}
            {ask.help ? <>{ask.hint ? ' ' : null}<a href={ask.help} className="underline" data-testid="app-credential-help"
              onClick={(event) => { event.preventDefault(); void rpc.app.openExternal(ask.help!); }}>{translate('extensions.credentialHelp')}</a></> : null}
          </p>
        ) : null}
        {reading.state === 'error' ? <p role="alert" className="text-sm text-muted-foreground">{translate('extensions.credentialUnavailable')}</p> : null}
        {state?.choices.length ? (
          <div className="flex items-center gap-2">
            <Select value={choice ?? undefined} disabled={busy} onValueChange={(next) => setPicked(String(next))}>
              <SelectTrigger className="min-w-0 flex-1" data-testid="app-credential-dialog-pick" aria-label={translate('extensions.credentialWhich')}>
                <SelectValue>{state.choices.find((entry) => entry.id === choice)?.label}</SelectValue>
              </SelectTrigger>
              <SelectContent align="start">
                {state.choices.map((entry) => <SelectItem key={entry.id} value={entry.id}>{entry.label}</SelectItem>)}
              </SelectContent>
            </Select>
            <Button variant="secondary" disabled={busy || !choice} onClick={() => void use()}>{translate('extensions.credentialUse')}</Button>
          </div>
        ) : null}
        <div className="flex flex-col gap-2">
          <span className="text-sm text-muted-foreground">{translate(state?.choices.length ? 'extensions.credentialSaveAnother' : 'extensions.credentialSaveNew', { site: ask.site })}</span>
          <Input aria-label={translate('extensions.credentialName')} placeholder={translate('extensions.credentialName')} value={name} disabled={busy}
            onChange={(event) => setName(event.target.value)} />
          <Input type="password" autoComplete="new-password" aria-label={translate('extensions.credentialValue')} placeholder={translate('extensions.credentialValue')}
            value={value} disabled={busy} data-testid="app-credential-dialog-value" onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter' && name.trim() && value.trim()) void save(); }} />
          <span className="text-xs text-muted-foreground">{translate('extensions.credentialKept', { site: ask.site })}</span>
        </div>
        {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
      </DialogContentArea>
      <DialogFooter>
        <Button variant="ghost" disabled={busy} onClick={onClose}>{translate('common.cancel')}</Button>
        <Button disabled={busy || !name.trim() || !value.trim()} onClick={() => void save()} data-testid="app-credential-dialog-save">{translate('extensions.credentialSave')}</Button>
      </DialogFooter>
    </>
  );
}
