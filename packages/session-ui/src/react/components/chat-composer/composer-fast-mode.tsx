import type { ReactElement, ReactNode } from 'react';
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
  const button = (
    <button
      type="button"
      className={detailRow ? styles.modelDetailFastSwitch : styles.modelFastMode}
      aria-label={label}
      data-fast-mode-toggle=""
      role={detailRow ? 'switch' : undefined}
      aria-checked={detailRow ? enabled : undefined}
      aria-pressed={detailRow ? undefined : enabled}
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
      {detailRow ? <span className={styles.modelDetailFastThumb} aria-hidden /> : <span className={styles.modelFastModePill}>
        <FastZap size={phoneActions ? 14 : 12} aria-hidden fill={enabled ? 'currentColor' : 'none'} />
        <span>{label}</span>
      </span>}
    </button>
  );
  const control = renderHint ? renderHint(button) : button;
  return detailRow ? (
    <div className={styles.contextThresholdTrigger} data-slot="composer-model-fast">
      <span>{label}</span>
      {control}
    </div>
  ) : control;
}
