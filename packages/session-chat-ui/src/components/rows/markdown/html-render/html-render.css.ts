/** html-render.css.ts — a ```html-render page: the frame fills the box its def measured, on the row's own background. */
import { style } from '@vanilla-extract/css';
import { vars } from '@session-chat/styles/theme.css';

export const htmlRenderFrame = style({ display: 'block', border: 0, background: 'transparent' });

/** The expanded page: over the whole window, on the host's modal layer and scrim (tokens.css), as the chat bubble's dialog. */
export const htmlRenderBackdrop = style({
  position: 'fixed',
  inset: 0,
  zIndex: 'var(--z-modal)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: 'var(--bg-overlay-modal)',
});

export const htmlRenderDialog = style({
  position: 'relative',
  width: 'min(92vw, 1100px)',
  maxHeight: '90vh',
  overflowY: 'auto',
  background: vars.bg,
  border: `1px solid ${vars.border}`,
  borderRadius: vars.radiusXl,
});

export const htmlRenderClose = style({
  position: 'absolute',
  top: '6px',
  right: '6px',
  zIndex: 1,
  display: 'flex',
  padding: '2px',
  borderRadius: vars.radiusSm,
  cursor: 'pointer',
  color: vars.fgPassive,
  selectors: { '&:hover': { color: vars.fg } },
});
