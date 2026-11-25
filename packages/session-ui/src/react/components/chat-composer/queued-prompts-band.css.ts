import { createContainer, style } from '@vanilla-extract/css';
import { vars } from '@session-ui/theme/core/contract/contract.css';
import { tokenVars } from '@session-ui/theme/tokens.css';
import { durFast } from '@session-ui/styles/effects/animations.css';

// The queue is a compact card above the composer. The composer stack has no backing of its own
// (messages scroll past behind it), so the card carries the composer's surface itself.
const bandContainer = createContainer();
export const band = style({
  containerName: bandContainer,
  containerType: 'inline-size',
  minWidth: 0,
  padding: '0.25rem 0.5rem',
  marginBottom: '0.5rem',
  borderRadius: tokenVars.radiusMd,
  backgroundColor: `var(--composer-bg, ${vars.surfaceBaseEmphasis})`,
  color: vars.foregroundMuted,
  fontSize: tokenVars.textSm,
});

export const list = style({
  display: 'flex',
  flexDirection: 'column',
  gap: '0.125rem',
  maxHeight: '30dvh',
  overflowX: 'hidden',
  overflowY: 'auto',
  overscrollBehavior: 'contain',
});

export const row = style({
  display: 'grid',
  gridTemplateColumns: 'auto minmax(0, 1fr) auto',
  alignItems: 'center',
  gap: '0.5rem',
  minHeight: '2rem',
  borderRadius: tokenVars.radiusMd,
  padding: '0.125rem 0.25rem',
  selectors: {
    '&:hover, &:focus-within': { backgroundColor: vars.surfaceHover },
    '&[data-dragging]': { opacity: 0.56 },
    '&[data-editing]': { opacity: 0.6 },
    '&[data-drag-over]': { backgroundColor: vars.surfaceSelected },
  },
});

// The status word 待发送 / Queued; with more than one entry the drag grip covers it on hover, as it covered the glyph.
// Too narrow for the word beside the text and the actions (a pane split down to its floor), the word gives way to the
// queue glyph and stays as the slot's title, as the composer's own labels give way to icons
// (@@@composer-toolbar-disclosure). 17rem: the widest action set (en 「Insert now」) still leaves the text a few glyphs.
const NARROW_BAND = `${bandContainer} (max-width: 17rem)`;
export const leadingSlot = style({ position: 'relative', display: 'flex', alignItems: 'center', height: '1.25rem' });
export const queueLabel = style({
  color: vars.foregroundMuted, whiteSpace: 'nowrap', lineHeight: '1.25rem',
  '@container': { [NARROW_BAND]: { display: 'none' } },
});
export const queueIcon = style({
  display: 'none', width: '1rem', height: '1rem', color: vars.foregroundMuted,
  '@container': { [NARROW_BAND]: { display: 'block' } },
});

export const dragHandle = style({
  position: 'absolute',
  inset: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  border: 0,
  borderRadius: tokenVars.radiusSm,
  backgroundColor: vars.surfaceHover,
  padding: 0,
  color: vars.foregroundMuted,
  cursor: 'grab',
  opacity: 0,
  transition: `opacity ${durFast}`,
  selectors: {
    [`${row}:hover &, ${row}:focus-within &`]: { opacity: 1 },
    [`${row}[data-dragging] &`]: { opacity: 1, cursor: 'grabbing' },
    '&:focus-visible:not([data-pointer-focus])': { opacity: 1, outline: `1px solid ${vars.border1}` },
  },
});
export const dragHandleIcon = style({ width: '0.875rem', height: '0.875rem' });

export const promptText = style({
  minWidth: 0,
  border: 0,
  backgroundColor: 'transparent',
  padding: 0,
  color: 'inherit',
  font: 'inherit',
  textAlign: 'left',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  lineHeight: '1.25rem',
  cursor: 'text',
  selectors: {
    '&:focus-visible:not([data-pointer-focus])': { outline: `1px solid ${vars.border1}`, outlineOffset: 2 },
    '&[data-locked="true"]': { cursor: 'default' },
  },
});
export const emptyText = style({ color: vars.foregroundMuted });

// Actions own a real grid column, so long text can never cover their targets.
export const actions = style({ display: 'flex', alignItems: 'center', gap: '0.125rem' });
export const actionIcon = style({ width: '0.875rem', height: '0.875rem', flexShrink: 0 });
export const sendNow = style({ whiteSpace: 'nowrap', gap: '0.25rem' });
