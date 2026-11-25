import { useRef, useState, type ReactElement, type ReactNode } from 'react';
import { FastZap } from '../../../icons';
import { useMessages } from '../../localization/message-provider';
import * as styles from './chat-composer.css';
import { sideAwayFromPicker } from './detail-card-side';

/** Hosts supply their existing tooltip without making session-ui depend on the app. */
/** Where the host puts the hint: the switch alone opens it above; the details row opens it beside the card. */
export interface FastModeHintPlacement { side: 'top' | 'left' | 'right' | 'bottom'; sideOffset: number }
export type RenderFastModeHint = (trigger: ReactElement, placement: FastModeHintPlacement) => ReactNode;

export function ComposerFastMode({
  enabled,
  disabled,
  onChange,
  renderHint,
  phoneActions = false,
  detailRow = false,
  picker = null,
}: {
  enabled: boolean;
  disabled?: boolean;
  onChange?: (enabled: boolean) => void;
  renderHint?: RenderFastModeHint;
  phoneActions?: boolean;
  detailRow?: boolean;
  /** The model list the details card sits beside (details row only): the hint opens on the card's other side. */
  picker?: HTMLElement | null;
}) {
  const { translate } = useMessages();
  const rowRef = useRef<HTMLDivElement>(null);
  const [rowSide, setRowSide] = useState<FastModeHintPlacement['side']>('left');
  const placeRowHint = () => setRowSide(sideAwayFromPicker(rowRef.current, picker, 192) ?? 'left');
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
  if (!detailRow) return renderHint ? renderHint(button, { side: 'top', sideOffset: 8 }) : button;
  // In the model details the hint belongs to the whole row, not only its switch.
  const row = (
    <div ref={rowRef} className={styles.contextThresholdTrigger} data-slot="composer-model-fast" onPointerEnter={placeRowHint} onFocus={placeRowHint}>
      <span>{label}</span>
      {button}
    </div>
  );
  // Beside the card, away from the list, as the effort menu opens (same 16px clears the card edge): above the row it would
  // cover the card's title or the Thinking row; on the list's side, the list.
  return renderHint ? renderHint(row, { side: rowSide, sideOffset: 16 }) : row;
}
