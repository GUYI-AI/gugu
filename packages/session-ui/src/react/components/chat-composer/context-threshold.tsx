import { useState, type ReactNode } from 'react';
import { ChevronRight, Check } from '../../../icons';
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
}

export type ComposerContextThresholds = (
  modelId: string,
  window: number | undefined
) => ContextThreshold | undefined;

const PRESETS = [64_000, 128_000, 200_000, 300_000, 600_000, 1_000_000];

function parseContextThreshold(text: string, minimum: number, maximum: number): number | null {
  const match = /^(\d+(?:\.\d+)?)\s*([km万]?)$/i.exec(text.trim());
  if (!match) return null;
  const factor = { k: 1_000, m: 1_000_000, 万: 10_000 }[match[2]!.toLowerCase()] ?? 1;
  const tokens = Number(match[1]) * factor;
  return Number.isSafeInteger(tokens) && tokens >= minimum && tokens <= maximum ? tokens : null;
}

export function ContextThresholdMenu({
  threshold, label, hover = false,
}: { threshold: ContextThreshold; label: ReactNode; hover?: boolean }) {
  const { translate } = useMessages();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [error, setError] = useState<'input' | 'save' | null>(null);
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState(false);
  const { minimum, maximum } = threshold;
  const current = threshold.value ?? maximum;
  const options = [...PRESETS.filter(value => value >= minimum && value < maximum), maximum];
  const commit = async (value: number) => {
    if (!threshold.set || saving) return;
    setSaving(true);
    try {
      await threshold.set(value === maximum ? null : value);
      setOpen(false);
    } catch {
      setError('save');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Popover.Root open={open} onOpenChange={(next, details) => {
      if (!next && details.reason === 'trigger-hover' && editing) {
        details.cancel();
        return;
      }
      setOpen(next);
      if (next) { setText(''); setError(null); }
    }}>
      <Popover.Trigger openOnHover={hover} delay={100} closeDelay={300}
        disabled={!threshold.set} className={styles.contextThresholdTrigger}>
        {label}<ChevronRight size={14} aria-hidden />
      </Popover.Trigger>
      <Popover.Content side="left" align="end" sideOffset={4} className={styles.contextThresholdContent}
        onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setEditing(false); }}>
        {minimum < maximum && <input className={styles.contextThresholdInput} aria-label={translate('composer.contextWindowThreshold')}
          placeholder={translate('composer.contextWindowThreshold')} value={text} aria-invalid={error ? true : undefined}
          onFocus={() => setEditing(true)}
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
          {translate('composer.contextThresholdRange', { minimum: formatTokenCount(minimum), maximum: formatTokenCount(maximum) })}
        </div>}
        {options.map(value => (
          <button type="button" key={value} disabled={saving} className={styles.contextThresholdOption}
            aria-pressed={current === value} onClick={() => void commit(value)}>
            {formatTokenCount(value)}{current === value && <Check size={14} aria-hidden />}
          </button>
        ))}
      </Popover.Content>
    </Popover.Root>
  );
}
