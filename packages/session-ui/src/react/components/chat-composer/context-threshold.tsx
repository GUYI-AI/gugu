import { useState, type ReactNode } from 'react';
import { Check } from '../../../icons';
import { Popover } from '@session-ui/react/primitives/popover';
import { formatTokenCount } from '@gugu/session-shared/format';
import { useMessages } from '../../localization/message-provider';
import * as styles from './chat-composer.css';

export interface ContextThreshold {
  minimum: number;
  maximum: number;
  value: number | null;
  unsupported?: boolean;
  set?: (value: number | null) => Promise<void>;
  selectedWindow?: number;
  selectWindow?: (window: number, effort?: string) => Promise<void>;
}

export type ComposerContextThresholds = (
  modelId: string,
  window: number | undefined
) => ContextThreshold | undefined;

export interface AutoCompactLimits {
  defaultTokens: number;
  ceiling: number;
}

export function effectiveAutoCompactThreshold(threshold: ContextThreshold, limits?: AutoCompactLimits): number | null {
  const tokens = threshold.value ?? limits?.defaultTokens;
  return tokens == null ? null : Math.min(tokens, limits?.ceiling ?? tokens, threshold.maximum - 1);
}

export function formatAutoCompactThreshold(tokens: number | null): string | null {
  return tokens == null ? null : `${tokens / 1000}K`;
}

const PRESETS = [64_000, 128_000, 200_000, 300_000, 600_000, 1_000_000];

function parseContextThreshold(text: string, minimum: number, maximum: number): number | null {
  const match = /^(\d+(?:\.\d+)?)\s*([km万]?)$/i.exec(text.trim());
  if (!match) return null;
  const factor = { k: 1_000, m: 1_000_000, 万: 10_000 }[match[2]!.toLowerCase()] ?? 1;
  const tokens = Number(match[1]) * factor;
  return Number.isSafeInteger(tokens) && tokens >= minimum && tokens < maximum ? tokens : null;
}

export function ContextThresholdChoices({ threshold, onCommit, lengths, defaultLength, effort, autoCompact }: {
  threshold: ContextThreshold;
  onCommit: () => void;
  lengths?: readonly number[];
  defaultLength?: number;
  effort?: string;
  autoCompact?: AutoCompactLimits;
}) {
  const { translate } = useMessages();
  const [text, setText] = useState('');
  const [error, setError] = useState<'input' | 'save' | null>(null);
  const [saving, setSaving] = useState(false);
  const { minimum, maximum } = threshold;
  const current = lengths ? threshold.selectedWindow ?? defaultLength : effectiveAutoCompactThreshold(threshold, autoCompact);
  const defaultValue = effectiveAutoCompactThreshold({ ...threshold, value: null }, autoCompact);
  const presets = PRESETS.filter(value => value >= minimum && value < maximum && value <= (autoCompact?.ceiling ?? value) && value !== defaultValue);
  if (!lengths && current != null && current !== defaultValue && !presets.includes(current)) presets.push(current);
  const options = lengths ?? presets.sort((a, b) => a - b);
  const commit = async (value: number | null) => {
    if (saving) return;
    setSaving(true);
    try {
      if (lengths && value != null) await threshold.selectWindow?.(value, effort);
      else await threshold.set?.(value);
      onCommit();
    } catch {
      setError('save');
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
        {lengths && <div className={styles.contextThresholdHeading}>{translate('composer.contextWindowThreshold')}</div>}
        {!lengths && minimum < maximum && <input className={styles.contextThresholdInput} aria-label={translate('composer.autoCompactCustom')}
          placeholder={translate('composer.autoCompactCustom')} value={text} aria-invalid={error ? true : undefined}
          onChange={event => { setText(event.target.value); setError(null); }}
          onKeyDown={event => {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            event.stopPropagation();
            const value = parseContextThreshold(text, minimum, maximum);
            if (value === null) setError('input');
            else void commit(value);
          }} />}
        {error === 'input' && <div role="alert" className={styles.contextThresholdError}>
          {translate('composer.contextThresholdRange', { minimum: formatTokenCount(minimum), maximum: formatExactThreshold(maximum - 1) })}
        </div>}
        {error === 'save' && <div role="alert" className={styles.contextThresholdError}>{translate('taskError.settingFailedRetry')}</div>}
        {options.map(value => (
          <button type="button" key={value} disabled={saving} className={styles.contextThresholdOption}
            aria-pressed={current === value} onClick={() => void commit(value)}>
            {lengths ? formatModelContextLength(value) : formatAutoCompactThreshold(value)}
            {current === value && <Check className={styles.modelSelectedCheck} size={14} aria-hidden />}
          </button>
        ))}
        {!lengths && <button type="button" disabled={saving} className={styles.contextThresholdOption}
          aria-pressed={current === defaultValue} onClick={() => void commit(null)}>
          {formatAutoCompactThreshold(defaultValue) ?? translate('composer.clearAutoCompactThreshold')}
          {current === defaultValue && <Check className={styles.modelSelectedCheck} size={14} aria-hidden />}
        </button>}
    </>
  );
}

export function formatModelContextLength(value: number): string {
  return formatTokenCount(value).replace(/k$/, 'K').replace(/\.0M$/, 'M');
}

export function formatExactThreshold(value: number): string {
  return value % 1000 === 0 ? formatModelContextLength(value) : String(value);
}

export function ContextThresholdMenu({ threshold, label, autoCompact }: { threshold: ContextThreshold; label: ReactNode; autoCompact?: AutoCompactLimits }) {
  const [open, setOpen] = useState(false);
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger disabled={!threshold.set} className={styles.contextThresholdTrigger}>
        {label}
      </Popover.Trigger>
      <Popover.Content side="left" align="start" sideOffset={12} className={styles.modelDetailSubmenu}
        collisionAvoidance={{ side: 'flip', align: 'shift', fallbackAxisSide: 'none' }}>
        {open && <ContextThresholdChoices threshold={threshold} autoCompact={autoCompact} onCommit={() => setOpen(false)} />}
      </Popover.Content>
    </Popover.Root>
  );
}
