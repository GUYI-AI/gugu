import { useEffect, useId, useState } from 'react';
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
 * no page of its own. `read` runs when `active` turns on; input typed before the page was moved or hidden stays until saved.
 */
export function AppSettingsForm({ manifest, active, read, save: write, id, hidden, labelledBy, role }: {
  manifest: ExtensionManifest;
  active: boolean;
  read: () => Promise<SettingsReply>;
  save: (settings: AppSettings) => Promise<SettingsReply>;
  id?: string;
  hidden?: boolean;
  labelledBy?: string;
  role?: string;
}) {
  const { translate: t } = useSessionMessages();
  const prefix = useId();
  const fields = manifest.settings ?? [];
  const [stored, setStored] = useState<AppSettings | null>(null);
  const [values, setValues] = useState<AppSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const dirty = values !== null && JSON.stringify(values) !== JSON.stringify(stored);

  useEffect(() => {
    if (!active) return;
    let disposed = false;
    void read().then((result) => {
      if (!result.success || !result.data) throw new Error(result.error ?? t('appSettings.readFailed'));
      const loaded = result.data;
      if (disposed) return;
      setStored((previous) => previous ?? loaded);
      setValues((previous) => previous ?? loaded);
    }).catch((cause: unknown) => { if (!disposed) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { disposed = true; };
  }, [manifest.id, active, t]);

  const save = async () => {
    if (!values) return;
    setSaving(true);
    setError(null);
    try {
      // An emptied field goes back to the author's default, which its placeholder shows.
      const settings = Object.fromEntries(Object.entries(values).filter(([, value]) => value !== ''));
      const result = await write(settings);
      if (!result.success || !result.data) throw new Error(result.error ?? t('appSettings.saveFailed'));
      setStored(result.data);
      setValues(result.data);
      setSaved(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };
  const change = (key: string, value: string | boolean) => {
    setValues((previous) => ({ ...previous, [key]: value }));
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
          <Switch id={fieldId} checked={values?.[field.key] === true} disabled={saving || !values} aria-describedby={about}
            onCheckedChange={(checked) => change(field.key, checked)} />
        </div>;
        return <div key={field.key} className="tool-app-field">
          <label htmlFor={fieldId}>{field.title}</label>
          {field.type === 'select' ? <Select items={field.options.map((option) => ({ value: option.value, label: option.title }))}
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
