import { useId, useState } from 'react';
import { useReplica } from '@/lib/replica';
import { Unknown } from '@/components/ui/Unknown';
import { extensionSettings } from './market-replicas';
import { Button } from '@renderer/lib/ui/button';
import { Input } from '@renderer/lib/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@renderer/lib/ui/select';
import { Switch } from '@renderer/lib/ui/switch';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import type { AppSettings } from '@shared/extensions/app-settings';
import type { ExtensionManifest } from '@shared/extensions/manifest';
import './app-settings-page.css';

type SettingsReply = { success: boolean; data?: AppSettings; error?: string };

/**
 * What an App's author declared (`settings`), drawn by the host: on the App's settings page, and on the page of an App with
 * no page of its own. The stored values are the `extensionSettings(hostKey, id)` replica, read when `active` turns on (and
 * on every open: no push); until they are, each control is a placeholder of its size (❌ a switch drawn off, an empty box).
 * Input typed before the page was moved or hidden stays until saved (the draft, this view's).
 */
export function AppSettingsForm({ manifest, active, hostKey, save: write, id, hidden, labelledBy, role }: {
  manifest: ExtensionManifest;
  active: boolean;
  hostKey: string;
  save: (settings: AppSettings) => Promise<SettingsReply>;
  id?: string;
  hidden?: boolean;
  labelledBy?: string;
  role?: string;
}) {
  const { translate: t } = useSessionMessages();
  const prefix = useId();
  const fields = manifest.settings ?? [];
  const reading = useReplica(extensionSettings, active ? [hostKey, manifest.id] : null);
  const stored = reading.state === 'value' ? reading.value : null;
  const [draft, setDraft] = useState<AppSettings | null>(null);
  const values = draft ?? stored;
  const [saveError, setSaveError] = useState<string | null>(null);
  const error = saveError ?? (reading.state === 'error' ? reading.error.message || t('appSettings.readFailed') : null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const dirty = draft !== null && JSON.stringify(draft) !== JSON.stringify(stored);

  const save = async () => {
    if (!values) return;
    setSaving(true);
    setSaveError(null);
    const entry = extensionSettings.at(hostKey, manifest.id);
    try {
      // An emptied field goes back to the author's default, which its placeholder shows.
      const settings = Object.fromEntries(Object.entries(values).filter(([, value]) => value !== ''));
      const result = await write(settings);
      if (!result.success || !result.data) throw new Error(result.error ?? t('appSettings.saveFailed'));
      entry.set(result.data);
      setDraft(null);
      setSaved(true);
    } catch (cause) {
      setSaveError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };
  const change = (key: string, value: string | boolean) => {
    setDraft((previous) => ({ ...(previous ?? stored), [key]: value }));
    setSaved(false);
  };

  return <>
    <form id={id} role={role} aria-labelledby={labelledBy} hidden={hidden} className="tool-app-fields"
      onSubmit={(event) => { event.preventDefault(); if (dirty) void save(); }}>
      {fields.map((field) => {
        const fieldId = `${prefix}-${field.key}`;
        const about = field.description ? `${fieldId}-about` : undefined;
        const description = field.description ? <p id={about}>{field.description}</p> : null;
        if (field.type === 'boolean') return <div key={field.key} className="tool-app-toggle">
          <div><label htmlFor={fieldId}>{field.title}</label>{description}</div>
          {values ? <Switch id={fieldId} checked={values[field.key] === true} disabled={saving} aria-describedby={about}
            onCheckedChange={(checked) => change(field.key, checked)} /> : <Unknown className="h-5 w-9" />}
        </div>;
        return <div key={field.key} className="tool-app-field">
          <label htmlFor={fieldId}>{field.title}</label>
          {!values ? <Unknown className="h-9 w-full" /> : field.type === 'select' ? <Select items={field.options.map((option) => ({ value: option.value, label: option.title }))}
            value={typeof values?.[field.key] === 'string' ? values[field.key] as string : null}
            onValueChange={(value) => { if (value !== null) change(field.key, value); }} disabled={saving || !values}>
            <SelectTrigger id={fieldId} aria-describedby={about}><SelectValue /></SelectTrigger>
            <SelectContent>{field.options.map((option) => <SelectItem key={option.value} value={option.value}>{option.title}</SelectItem>)}</SelectContent>
          </Select> : <Input id={fieldId} value={String(values?.[field.key] ?? '')} maxLength={4096} disabled={saving || !values} spellCheck={false}
            placeholder={typeof field.default === 'string' ? field.default : undefined} aria-describedby={about}
            onChange={(event) => change(field.key, event.target.value)} />}
          {description}
        </div>;
      })}
      {dirty ? <div><Button type="submit" size="sm" disabled={saving}>{t('appSettings.save')}</Button></div>
        : saved ? <p role="status" className="tool-app-saved">{t('appSettings.saved')}</p> : null}
    </form>
    {error ? <p role="alert" className="tool-app-error">{error}</p> : null}
  </>;
}
