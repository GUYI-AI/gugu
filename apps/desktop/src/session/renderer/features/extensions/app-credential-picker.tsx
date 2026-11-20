import { useEffect, useRef, useState } from 'react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@renderer/lib/ui/select';
import { rpc } from '@renderer/lib/ipc';
import { translateSessionMessage } from '@renderer/localization/locale-store';
import { usePasswordSnapshot } from '@/lib/passwordBetaNotifications';
import { rendererLogger } from '@/lib/log';
import { replica, useReplica, type Reading } from '@/lib/replica';

const log = rendererLogger('extensions/credentials');

/** A host answer, or its reason as a thrown error (logged here; the surface says only what the person can do). */
async function answer<V>(read: Promise<{ success: true; data?: V } | { success: false; error: string }>, detail: Record<string, string>): Promise<V> {
  const result = await read;
  if (result.success && result.data !== undefined) return result.data;
  const reason = result.success ? 'no answer' : result.error;
  log.warn({ ...detail, reason }, 'saved credentials unreadable');
  throw new Error(reason);
}
// This device's vault, read by the host; read again on every vault change (a credential added or edited elsewhere).
const siteChoices = replica({ name: 'appCredentialChoices', scope: 'device',
  read: (_owner: string, site: string) => answer(rpc.extensions.credentialChoices({ site }), { site }) });
const appCredentialStates = replica({ name: 'appCredentialStates', scope: 'device',
  read: (_owner: string, extensionId: string) => answer(rpc.extensions.appCredentials({ extensionId }), { extensionId }) });
function useVaultRefresh(): void {
  const vault = usePasswordSnapshot(), seen = useRef(vault);
  useEffect(() => {
    if (seen.current === vault) return;
    seen.current = vault;
    void siteChoices.refresh(); void appCredentialStates.refresh();
  }, [vault]);
}

/**
 * Which saved credential of a website an App uses (App API 60): one picker, drawn in an install's sheet and in the App's
 * permissions. The choices are the password vault's credentials for that website, read by the host (again on every vault change); picking one is the
 * person's grant to the App. No value ever reaches here.
 */
type Choices = NonNullable<Awaited<ReturnType<typeof rpc.extensions.credentialChoices>>['data']>;
const NONE = '__none__';

/** The saved credentials for `site`, and the connector's pick as the default: unknown until read, or the vault's error. */
export function useCredentialChoices(site: string): Reading<Choices> {
  useVaultRefresh();
  return useReplica(siteChoices, [site]);
}

export function CredentialPicker({ site, value, onChange, choices, disabled, testId }: {
  site: string; value: string | null; onChange: (id: string | null) => void; choices: Choices; disabled?: boolean; testId?: string;
}) {
  const t = translateSessionMessage;
  const label = (id: string | null) => {
    const choice = choices.choices.find((entry) => entry.id === id);
    if (!choice) return t('extensions.credentialNone');
    return id === choices.connector ? `${choice.label} ${t('extensions.credentialConnectorUses')}` : choice.label;
  };
  if (!choices.choices.length) return <p className="text-[length:var(--font-caption)]" data-testid={testId ? `${testId}-empty` : undefined}>{t('extensions.credentialEmpty', { site })}</p>;
  return (
    <Select value={value ?? NONE} disabled={disabled} onValueChange={(next) => onChange(next === NONE ? null : String(next))}>
      <SelectTrigger data-testid={testId} aria-label={t('extensions.credentialWhich')}><SelectValue>{label(value)}</SelectValue></SelectTrigger>
      <SelectContent align="start">
        {choices.choices.map((choice) => (
          <SelectItem key={choice.id} value={choice.id}>
            <span className="flex flex-col"><span>{choice.label}{choice.id === choices.connector ? ` ${t('extensions.credentialConnectorUses')}` : ''}</span>
              <span className="text-xs text-muted-foreground">{choice.detail}</span></span>
          </SelectItem>
        ))}
        <SelectItem value={NONE}>{t('extensions.credentialNone')}</SelectItem>
      </SelectContent>
    </Select>
  );
}

/** The sheet's part: one picker per website, defaulting to the connector's pick (or the only one saved). */
export function ConsentCredentialPickers({ sites, picks, onPick }: { sites: string[]; picks: Record<string, string | null>; onPick: (site: string, id: string | null) => void }) {
  return <div className="!mt-3 flex flex-col gap-3" data-testid="extension-consent-credentials">
    {sites.map((site) => <ConsentCredentialPicker key={site} site={site} pick={picks[site]} onPick={(id) => onPick(site, id)} />)}
    <div className="text-[length:var(--font-caption)] text-[var(--text-tertiary)]">{translateSessionMessage('extensions.credentialLater')}</div>
  </div>;
}

function ConsentCredentialPicker({ site, pick, onPick }: { site: string; pick: string | null | undefined; onPick: (id: string | null) => void }) {
  const reading = useCredentialChoices(site);
  // The default once the choices are read: what the connector uses, else the one saved.
  useEffect(() => {
    if (reading.state !== 'value' || pick !== undefined) return;
    const { connector, choices } = reading.value;
    onPick(connector ?? (choices.length === 1 ? choices[0]!.id : null));
  }, [reading, pick, onPick]);
  return <div className="flex flex-col gap-2">
    <div className="font-semibold text-[var(--text-primary)]">{translateSessionMessage('extensions.credentialWhich')} · {site}</div>
    {reading.state === 'error' ? <p role="alert">{translateSessionMessage('extensions.credentialUnavailable')}</p>
      : reading.state === 'value' ? <CredentialPicker site={site} value={pick ?? null} onChange={onPick} choices={reading.value} testId={`extension-consent-credential-${site}`} />
        : null /* not read yet: no picker rather than an empty one */}
  </div>;
}

/**
 * The App's permissions: one row per website it may use a saved credential on — which one, picked again or taken back
 * here, and when its code changed since the person confirmed it, a 「重新确认」 that binds it to the code installed now.
 */
export function AppCredentialRows({ extensionId, hosts, disabled }: { extensionId: string; hosts: readonly string[]; disabled: boolean }) {
  const t = translateSessionMessage;
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useVaultRefresh();
  const reading = useReplica(appCredentialStates, [extensionId]);
  const set = async (site: string, credentialId: string | null) => {
    setBusy(true);
    try {
      const result = await rpc.extensions.setAppCredential({ extensionId, site, credentialId });
      setError(result.success ? '' : result.error);
      await appCredentialStates.refresh(extensionId);
    } finally { setBusy(false); }
  };
  if (reading.state === 'unknown') return null; // not read yet: no rows rather than empty ones
  if (reading.state === 'error') return <div className="mg-row mk-pl mg-permission" role="alert" data-testid="app-credential-error">{t('extensions.credentialUnavailable')}</div>;
  return <>{reading.value.map((state) => (
    <div className="mg-row mk-pl mg-permission" key={state.site} data-testid={`app-credential-${state.site}`}>
      <span>
        {t('extensions.credentialRow', { site: state.site, hosts: hosts.filter((host) => { const bare = host.replace(/^\*\./, ''); return bare === state.site || bare.endsWith(`.${state.site}`); }).join(', ') })}
        {state.stale ? <small className="block text-[var(--text-error)]" data-testid={`app-credential-${state.site}-stale`}>{t('extensions.credentialStale')}</small> : null}
        {error ? <small role="alert" className="block text-[var(--text-error)]">{error}</small> : null}
      </span>
      <CredentialPicker site={state.site} value={state.chosen?.id ?? null} choices={{ choices: state.choices, connector: state.connector }}
        disabled={disabled || busy} onChange={(id) => void set(state.site, id)} testId={`app-credential-${state.site}-pick`} />
      {state.stale && state.chosen ? <button type="button" className="mk-link" disabled={disabled || busy} onClick={() => void set(state.site, state.chosen!.id)}
        data-testid={`app-credential-${state.site}-confirm`}>{t('extensions.credentialConfirmAgain')}</button> : null}
    </div>
  ))}</>;
}
