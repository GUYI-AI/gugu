import type { ReactElement, ReactNode } from 'react';
import { FastZap } from '../../../icons';
import * as styles from './chat-composer.css';

/** Hosts supply their existing tooltip without making session-ui depend on the app. */
export type RenderFastModeHint = (button: ReactElement) => ReactNode;

export function ComposerFastMode({
  enabled,
  disabled,
  onChange,
  renderHint,
}: {
  enabled: boolean;
  disabled?: boolean;
  onChange?: (enabled: boolean) => void;
  renderHint?: RenderFastModeHint;
}) {
  const button = (
    <button
      type="button"
      className={styles.modelFastMode}
      aria-label="Fast"
      aria-pressed={enabled}
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
      <FastZap size={12} aria-hidden fill={enabled ? 'currentColor' : 'none'} />
    </button>
  );
  return renderHint ? renderHint(button) : button;
}
