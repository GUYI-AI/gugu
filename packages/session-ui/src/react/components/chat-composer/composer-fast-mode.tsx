import type { ReactElement, ReactNode } from 'react';
import { Switch } from '@base-ui/react/switch';
import { FastZap } from '../../../icons';
import { useMessages } from '../../localization/message-provider';
import * as styles from './chat-composer.css';

/** Hosts supply their existing tooltip without making session-ui depend on the app. */
export type RenderFastModeHint = (button: ReactElement) => ReactNode;

export function ComposerFastMode({
  enabled,
  disabled,
  onChange,
  renderHint,
  phoneActions = false,
  detailRow = false,
}: {
  enabled: boolean;
  disabled?: boolean;
  onChange?: (enabled: boolean) => void;
  renderHint?: RenderFastModeHint;
  phoneActions?: boolean;
  detailRow?: boolean;
}) {
  const { translate } = useMessages();
  const label = translate('composer.fastModeLabel');
  if (detailRow) {
    const toggle = (
      <Switch.Root checked={enabled} disabled={disabled || !onChange} aria-label={label}
        className={styles.modelDetailFastSwitch} data-fast-mode-toggle="" onCheckedChange={onChange}>
        <Switch.Thumb className={styles.modelDetailFastThumb} />
      </Switch.Root>
    );
    return (
      <div className={styles.contextThresholdTrigger} data-slot="composer-model-fast">
        <span>{label}</span>
        {renderHint ? renderHint(toggle) : toggle}
      </div>
    );
  }
  const button = (
    <button
      type="button"
      className={styles.modelFastMode}
      aria-label={label}
      data-fast-mode-toggle=""
      aria-pressed={enabled}
      data-phone-fast={phoneActions || undefined}
      disabled={disabled || !onChange}
      onPointerDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onChange?.(!enabled);
      }}
    >
      <span className={styles.modelFastModePill}>
        <FastZap size={phoneActions ? 14 : 12} aria-hidden fill={enabled ? 'currentColor' : 'none'} />
        <span>{label}</span>
      </span>
    </button>
  );
  return renderHint ? renderHint(button) : button;
}
