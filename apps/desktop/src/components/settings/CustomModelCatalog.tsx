import { useEffect, useId, useRef, useState, type PointerEvent, type ReactNode } from 'react';
import { CUSTOM_MODEL_EFFORT_LEVELS, customModelAcceptsImages, customModelCatalogLevels, customModelThinks, type CustomModelEffortLevel, type CustomModelEntry } from '@gugu/session-core/models/custom-model';
import { Combobox, ComboboxChip, ComboboxChips, ComboboxChipsInput, ComboboxContent, ComboboxEmpty, ComboboxItem, ComboboxList, useComboboxAnchor } from '@renderer/lib/ui/combobox';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@renderer/lib/ui/select';
import { Checkbox } from '@renderer/lib/ui/checkbox';
import { Input } from '@renderer/lib/ui/input';
import { Button } from '@renderer/lib/ui/button';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import type { ModelList } from '@renderer/features/settings/subscriptions/ConnectionModelPicker';

type ModelSettings = Partial<Omit<CustomModelEntry, 'id'>>;
type ModelSettingsUpdate = (entry: ModelSettings | undefined) => ModelSettings;

export function ModelCatalogPicker({ ids, value, onChange, entries, labelId, statusId }: {
  ids: string[];
  value: string[];
  onChange: (ids: string[]) => void;
  entries?: ReadonlyMap<string, CustomModelEntry>;
  labelId?: string;
  statusId?: string;
}) {
  const { translate } = useSessionMessages();
  const anchor = useComboboxAnchor();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const cancelClose = () => clearTimeout(closeTimer.current);
  useEffect(() => () => clearTimeout(closeTimer.current), []);
  const scheduleClose = (event: PointerEvent) => {
    if (event.pointerType !== 'mouse') return;
    cancelClose();
    // Allow the pointer to cross the gap between the field and the portaled list.
    closeTimer.current = setTimeout(() => setOpen(false), 180);
  };
  const needle = query.trim().toLowerCase();
  const label = (id: string) => entries?.get(id)?.label || id;
  const shown = ids.filter(id => id.toLowerCase().includes(needle) || label(id).toLowerCase().includes(needle));
  const searchLabel = translate('subscriptions.connections.modelsSearch');

  return <Combobox<string, true> multiple openOnInputClick={false} items={ids} filteredItems={shown} value={value} open={open}
    inputValue={query} onInputValueChange={setQuery} onOpenChange={setOpen}
    onValueChange={next => { onChange(next); setQuery(''); }}>
    <ComboboxChips ref={anchor} data-testid="custom-model-picker" className="gg-model-picker max-h-32 gap-y-1 overflow-y-auto"
      onPointerEnter={cancelClose} onPointerLeave={scheduleClose}>
      {value.map(id => <ComboboxChip key={id} className="max-w-full"
        removeLabel={translate('customModels.removeSelection', { model: label(id) })}>
        <span className="min-w-0 truncate" title={id}>{label(id)}</span>
      </ComboboxChip>)}
      <ComboboxChipsInput aria-label={searchLabel} aria-describedby={statusId}
        aria-labelledby={labelId} placeholder={value.length ? '' : searchLabel}
        onClick={event => {
          event.currentTarget.focus();
          cancelClose();
          if (ids.length) setOpen(true);
        }}
        onKeyDown={event => { if (event.key === 'Enter') event.preventDefault(); }} />
    </ComboboxChips>
    <ComboboxContent anchor={anchor} initialFocus={false} onPointerEnter={cancelClose} onPointerLeave={scheduleClose}>
      <ComboboxEmpty className="px-3 py-2">{translate('subscriptions.connections.modelsNoMatch')}</ComboboxEmpty>
      <ComboboxList aria-label={translate('subscriptions.connections.models')}>
        {(id: string) => (
          <ComboboxItem key={id} value={id} className="data-selected:bg-transparent data-selected:data-highlighted:bg-row-hover">
            <span className="truncate" title={id}>{label(id)}</span>
          </ComboboxItem>
        )}
      </ComboboxList>
    </ComboboxContent>
  </Combobox>;
}

export function CustomModelCatalog({ list, enabled, entries, onChange, allowManual }: {
  list: ModelList;
  enabled: string[];
  entries: ReadonlyMap<string, CustomModelEntry>;
  onChange: (ids: string[]) => void;
  allowManual: boolean;
}) {
  const { translate } = useSessionMessages();
  const labelId = useId();
  const [manualModel, setManualModel] = useState('');
  const available = list.kind === 'listed' ? list.models : [];
  const ids = [...new Set([...available, ...enabled, ...entries.keys()])];
  const status = list.kind === 'reading' ? 'subscriptions.connections.modelsReading'
    : ids.length === 0 && !allowManual ? 'subscriptions.connections.modelsWaiting' : null;
  const statusId = status ? `${labelId}-status` : undefined;

  return <div className="subscription-connection-models">
    <div className="flex flex-wrap items-center gap-2">
      <span id={labelId}>{translate('subscriptions.connections.models')}</span>
      {status && <span id={statusId} role="status" className="text-[length:var(--font-caption)]">{translate(status)}</span>}
    </div>
    <ModelCatalogPicker ids={ids} value={enabled} onChange={onChange} entries={entries} labelId={labelId} statusId={statusId} />
    {allowManual && <div className="flex items-center gap-2">
      <Input aria-label={translate('customModels.modelName')} placeholder={translate('customModels.modelNamePlaceholder')} value={manualModel}
        maxLength={200} onChange={event => setManualModel(event.target.value)}
        onKeyDown={event => { if (event.key === 'Enter') event.preventDefault(); }} />
      <Button type="button" variant="outline" size="sm" disabled={!manualModel.trim() || enabled.includes(manualModel.trim())}
        onClick={() => { onChange([...enabled, manualModel.trim()]); setManualModel(''); }}>{translate('customModels.add')}</Button>
    </div>}
  </div>;
}

const INPUT_LIMITS = [['32K', 32_768], ['64K', 65_536], ['128K', 131_072], ['256K', 262_144]] as const;
const OUTPUT_LIMITS = [['8K', 8_192], ['16K', 16_384], ['32K', 32_768], ['64K', 65_536]] as const;

export function CatalogModelFields({ entries, onChange, protocolControl }: {
  entries: readonly (ModelSettings | undefined)[];
  protocolControl: ReactNode;
  onChange: (patch: ModelSettings | ModelSettingsUpdate) => void;
}) {
  const { translate } = useSessionMessages();
  const effortLabelId = useId();
  const mixed = translate('customModels.mixedValues');
  const sameValue = <T,>(read: (entry: ModelSettings | undefined) => T) => {
    const first = read(entries[0]);
    const differs = entries.some(entry => read(entry) !== first);
    return { value: differs ? undefined : first, differs };
  };
  const thinking = sameValue(customModelThinks);
  const levelsOf = (entry: ModelSettings | undefined) => entry?.efforts ?? customModelCatalogLevels(entry?.effortCatalog);
  const levels = CUSTOM_MODEL_EFFORT_LEVELS.map(level => ({ level, ...sameValue(entry => levelsOf(entry).includes(level)) }));
  const defaultEffort = sameValue(entry => {
    const value = entry?.defaultEffort;
    return value && levelsOf(entry).includes(value) ? value : undefined;
  });
  const effortLabel = (level?: CustomModelEffortLevel) => translate(level ? `customModels.effort.${level}` : 'customModels.effortAuto');
  const checkbox = (label: string, { value, differs }: { value?: boolean; differs: boolean }, onCheckedChange: (checked: boolean) => void) => (
    <label className="gg-model-check"><Checkbox checked={value ?? false} indeterminate={differs} onCheckedChange={onCheckedChange} />{label}</label>
  );
  const limitField = (key: 'contextWindow' | 'maxOutput', presets: typeof INPUT_LIMITS | typeof OUTPUT_LIMITS) => {
    const { value, differs } = sameValue(entry => entry?.[key]);
    return (
    <label className="gg-model-field">
      <span className="gg-model-field-label">{translate(key === 'contextWindow' ? 'customModels.inputLimit' : 'customModels.outputLimit')}</span>
      <Input type="number" min="1" step="1" inputMode="numeric" value={value ?? ''}
        placeholder={differs ? mixed : translate('customModels.limitDefault')}
        onChange={event => onChange({ [key]: event.target.value === '' ? undefined : event.target.valueAsNumber })} />
      <span className="gg-model-limit-presets flex-wrap">
        {presets.map(([label, tokens]) => <Button key={tokens} size="sm" type="button" variant="ghost"
          aria-pressed={value === tokens} onClick={() => onChange({ [key]: tokens })}>{label}</Button>)}
      </span>
    </label>
    );
  };

  return <>
    <div className="gg-model-checks">
      {checkbox(translate('customModels.toolCall'), sameValue(entry => entry?.toolCall ?? true), toolCall => onChange({ toolCall }))}
      {checkbox(translate('customModels.image'), sameValue(customModelAcceptsImages), image => onChange({ image }))}
      {checkbox(translate('customModels.thinking'), thinking, next => onChange({ thinking: next }))}
      {thinking.value !== false && checkbox(translate('customModels.thinkingOnly'), sameValue(entry => entry?.thinkingOnly ?? false), thinkingOnly => onChange({ thinkingOnly }))}
      {thinking.value !== false && checkbox(translate('customModels.thinkingOptional'), sameValue(entry => entry?.thinkingOptional ?? true), thinkingOptional => onChange({ thinkingOptional }))}
      {protocolControl}
    </div>
    {thinking.value !== false && <div className="gg-model-thinking">
      <div className="gg-model-field">
        <span id={effortLabelId} className="gg-model-field-label">{translate('customModels.defaultEffort')}</span>
        <Select value={defaultEffort.differs ? null : defaultEffort.value ?? 'auto'} onValueChange={value => {
          if (!value) return;
          const level = CUSTOM_MODEL_EFFORT_LEVELS.find(candidate => candidate === value);
          if (!level) {
            onChange({ defaultEffort: undefined });
            return;
          }
          onChange(entry => {
            const previous = levelsOf(entry);
            return {
              defaultEffort: level,
              efforts: CUSTOM_MODEL_EFFORT_LEVELS.filter(candidate => candidate === level || previous.includes(candidate)),
            };
          });
        }}>
          <SelectTrigger aria-labelledby={effortLabelId} className="w-full"><SelectValue>{defaultEffort.differs ? mixed : effortLabel(defaultEffort.value)}</SelectValue></SelectTrigger>
          <SelectContent alignItemWithTrigger={false} align="start">
            <SelectItem value="auto">{effortLabel()}</SelectItem>
            {CUSTOM_MODEL_EFFORT_LEVELS.map(level => <SelectItem key={level} value={level}>{effortLabel(level)}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
      <fieldset className="gg-model-field">
        <legend className="gg-model-field-label">{translate('customModels.supportedEfforts')}</legend>
        <div className="gg-model-levels mt-1.5">
          {levels.map(({ level, value, differs }) => <div key={level}>{checkbox(effortLabel(level), { value, differs }, checked => {
            onChange(entry => {
              const previous = levelsOf(entry);
              const next = CUSTOM_MODEL_EFFORT_LEVELS.filter(id => id === level ? checked : previous.includes(id));
              const selected = entry?.defaultEffort;
              return { efforts: next, defaultEffort: selected && next.includes(selected) ? selected : undefined };
            });
          })}</div>)}
        </div>
      </fieldset>
    </div>}
    <div className="gg-model-limits">
      {limitField('contextWindow', INPUT_LIMITS)}
      {limitField('maxOutput', OUTPUT_LIMITS)}
    </div>
  </>;
}
