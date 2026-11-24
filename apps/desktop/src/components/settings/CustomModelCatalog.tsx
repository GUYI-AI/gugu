import { useId, useRef, useState, type RefObject } from 'react';
import { customModelAcceptsImages, type CustomModelEntry } from '@gugu/session-core/models/custom-model';
import { Link, Pencil } from '@/lib/icons';
import { IconButton } from '@/components/ui/IconButton';
import { SearchField } from '@/components/ui/SearchField';
import { Input } from '@renderer/lib/ui/input';
import { Button } from '@renderer/lib/ui/button';
import { Dialog, DialogContent, DialogContentArea, DialogDescription, DialogHeader, DialogTitle } from '@renderer/lib/ui/dialog';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import type { ModelList } from '@renderer/features/settings/subscriptions/ConnectionModelPicker';
import { Toggle } from './SettingsPrimitives';

type ModelSettings = Partial<Omit<CustomModelEntry, 'id'>>;

export function CustomModelCatalog({ list, enabled, entries, onChange, onEdit, onTest }: {
  list: ModelList;
  enabled: string[];
  entries: ReadonlyMap<string, CustomModelEntry>;
  onChange: (ids: string[]) => void;
  onEdit: (id: string, patch: ModelSettings) => void;
  onTest?: (id: string) => Promise<string>;
}) {
  const { translate } = useSessionMessages();
  const listId = useId();
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<string>();
  const [test, setTest] = useState<{ id: string; feedback: string | null }>();
  const runTest = async (id: string) => {
    if (!onTest || test?.feedback === null) return;
    setTest({ id, feedback: null });
    setTest({ id, feedback: await onTest(id) });
  };
  const editButton = useRef<HTMLButtonElement>(null);
  const active = new Set(enabled);
  const available = list.kind === 'listed' ? list.models : [];
  const ids = [...new Set([...enabled, ...available, ...entries.keys()])];
  const needle = query.trim().toLowerCase();
  const visibleIds = ids.filter(id => id.toLowerCase().includes(needle) || entries.get(id)?.label?.toLowerCase().includes(needle));
  const searchLabel = translate('subscriptions.connections.modelsSearch');
  const canSearch = ids.length > 0 || list.kind === 'listed';
  const statusId = `${listId}-status`;
  const status = list.kind === 'reading' ? 'subscriptions.connections.modelsReading'
    : !canSearch ? 'subscriptions.connections.modelsWaiting' : null;

  return <div className="subscription-connection-models">
    <div className="flex flex-wrap items-baseline gap-x-2">
      <span>{translate('subscriptions.connections.models')}</span>
      {status && <span id={statusId} role="status" className="text-[length:var(--font-caption)]">{translate(status)}</span>}
    </div>
    <div className="relative">
      <SearchField value={query} disabled={!canSearch} aria-label={searchLabel}
        aria-controls={canSearch ? listId : undefined} aria-describedby={status ? statusId : undefined} placeholder={searchLabel}
        onChange={event => setQuery(event.target.value)}
        onKeyDown={event => { if (event.key === 'Enter') event.preventDefault(); }} />
      {canSearch && <div id={listId} role="region" aria-label={translate('subscriptions.connections.models')}
        className="mt-1 max-h-64 overflow-y-auto overscroll-contain rounded-md border">
        {visibleIds.length === 0 && <p className="px-3 py-2 text-sm text-foreground-muted">{translate('subscriptions.connections.modelsNoMatch')}</p>}
        {visibleIds.map(id => {
          const entry = entries.get(id);
          const checked = active.has(id);
          return <div key={id} className="flex min-h-9 items-center gap-2 border-b px-3 last:border-b-0">
            <span title={id} className="min-w-0 flex-1 truncate text-sm">{entry?.label || id}</span>
            {checked && onTest && <IconButton size="sm" aria-label={translate('customModels.test')} title={translate('customModels.test')}
              disabled={test?.feedback === null} onClick={() => void runTest(id)}><Link className="size-4" aria-hidden /></IconButton>}
            <IconButton size="sm" aria-label={translate('customModels.editModel', { model: id })} aria-haspopup="dialog"
              onClick={event => {
                editButton.current = event.currentTarget;
                setEditing(id);
              }}><Pencil className="size-4" aria-hidden /></IconButton>
            <Toggle checked={checked} ariaLabel={translate('customModels.enableModel', { model: id })}
              onChange={next => onChange(next ? [...enabled, id] : enabled.filter(model => model !== id))} />
          </div>;
        })}
      </div>}
    </div>
    {onTest && test?.feedback && <p role="status" className="text-[length:var(--font-caption)]">{test.id} · {test.feedback}</p>}
    {editing && <ModelSettingsDialog key={editing} model={editing} entry={entries.get(editing)} finalFocus={editButton}
      onClose={() => setEditing(undefined)} onApply={patch => {
        onEdit(editing, patch);
        setEditing(undefined);
      }} />}
  </div>;
}

function ModelSettingsDialog({ model, entry, finalFocus, onClose, onApply }: {
  model: string;
  entry?: CustomModelEntry;
  finalFocus: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
  onApply: (patch: ModelSettings) => void;
}) {
  const { translate } = useSessionMessages();
  const [draft, setDraft] = useState<ModelSettings>({});
  const settings = { ...entry, ...draft };
  const update = (patch: ModelSettings) => setDraft(current => ({ ...current, ...patch }));

  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
    <DialogContent className="sm:max-w-sm" finalFocus={finalFocus}>
      <DialogHeader><DialogTitle>{translate('customModels.advanced')}</DialogTitle></DialogHeader>
      <DialogContentArea>
        <DialogDescription className="break-all">{entry?.label || model}</DialogDescription>
        <form className="subscription-connection-form" onSubmit={event => {
          event.preventDefault();
          // The dialog is portaled, but React submit events still bubble to the connection form.
          event.stopPropagation();
          if (Object.keys(draft).length) onApply(draft);
          else onClose();
        }}>
          <div className="flex items-center justify-between">{translate('customModels.image')}<Toggle checked={customModelAcceptsImages(settings)}
            onChange={image => update({ image })} ariaLabel={translate('customModels.image')} /></div>
          <div className="flex items-center justify-between">{translate('customModels.thinking')}<Toggle checked={settings.thinking === true}
            onChange={thinking => update({ thinking })} ariaLabel={translate('customModels.thinking')} /></div>
          {(['contextWindow', 'maxOutput'] as const).map(key => <label key={key}>
            {translate(key === 'contextWindow' ? 'customModels.context' : 'customModels.output')}
            <Input type="number" min="1" step="1" placeholder={translate('customModels.default')} value={settings[key] ?? ''}
              onChange={event => update({ [key]: event.target.value ? Number(event.target.value) : undefined })} />
          </label>)}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" size="sm" onClick={onClose}>{translate('common.cancel')}</Button>
            <Button type="submit" size="sm">{translate('common.confirm')}</Button>
          </div>
        </form>
      </DialogContentArea>
    </DialogContent>
  </Dialog>;
}
