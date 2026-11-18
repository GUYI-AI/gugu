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
}: {
  enabled: boolean;
  disabled?: boolean;
  onChange?: (enabled: boolean) => void;
  renderHint?: RenderFastModeHint;
  phoneActions?: boolean;
}) {
  const { translate } = useMessages();
  const label = phoneActions ? 'Fast' : translate('composer.fastModeLabel');
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
