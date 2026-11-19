import { style } from '@vanilla-extract/css';
import { vars } from '@session-chat/styles/theme.css';

/** The card's own geometry is inline (it is measured before it is drawn); only the quiet actions' hover needs a selector. */
export const passwordQuietAction = style({
  transition: 'background-color 150ms ease, color 150ms ease',
  selectors: {
    '&:hover, &:focus-visible:not([data-pointer-focus])': { background: `${vars.bgHover} !important`, color: `${vars.fg} !important`, outline: 'none' },
    '&:active': { background: `${vars.bgPress} !important` },
  },
});

/** The form's inputs: filled, no border; the placeholder a step quieter than the value. */
export const passwordInput = style({
  selectors: {
    '&::placeholder': { color: vars.fgPassive },
    '&:focus': { boxShadow: `0 0 0 1px color-mix(in srgb, ${vars.fg} 18%, transparent)` },
    '&:disabled': { opacity: 0.6 },
  },
});

/** ⓘ after 「存到咕咕」: what ticking does, shown above the row on hover or focus (the card clips anything outside it). */
export const passwordTip = style({
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: '14px', height: '14px', borderRadius: '50%',
  border: `1px solid color-mix(in srgb, ${vars.fg} 30%, transparent)`, color: vars.fgMuted, fontSize: '9px', fontWeight: 600,
  fontStyle: 'italic', fontFamily: 'Georgia, serif', lineHeight: 1, cursor: 'help', boxSizing: 'border-box', outline: 'none',
  selectors: {
    '&::after': { content: 'attr(data-tip)', position: 'absolute', left: 0, right: 0, bottom: 'calc(100% + 6px)', padding: '8px 10px',
      borderRadius: '8px', background: vars.fg, color: vars.bg, fontFamily: vars.fontSans, fontStyle: 'normal', fontWeight: 400, fontSize: '12px',
      lineHeight: '16px', whiteSpace: 'normal', opacity: 0, pointerEvents: 'none', transition: 'opacity 120ms ease', zIndex: 1 },
    '&:hover::after, &:focus-visible:not([data-pointer-focus])::after': { opacity: 1 },
    '&:hover, &:focus-visible:not([data-pointer-focus])': { color: vars.fg },
  },
});

/** A half of the split button: a step lighter on hover, the pill itself stays one shape. */
export const passwordSplitPart = style({
  transition: 'background-color 150ms ease',
  selectors: {
    '&:hover, &:focus-visible:not([data-pointer-focus])': { background: `color-mix(in srgb, ${vars.bg} 14%, transparent) !important`, outline: 'none' },
    '&:active': { background: `color-mix(in srgb, ${vars.bg} 22%, transparent) !important` },
  },
});

/** An input with its icons: they show on hover or focus, inside the input after the text. */
export const passwordField = style({});
export const passwordFieldIcons = style({
  opacity: 0, transition: 'opacity 120ms ease',
  selectors: { [`${passwordField}:hover &, ${passwordField}:focus-within &`]: { opacity: 1 } },
});
export const passwordIconButton = style({
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: '24px', height: '24px', padding: 0, border: 'none',
  borderRadius: '6px', background: 'transparent', color: vars.fgMuted, cursor: 'pointer',
  selectors: {
    '&:hover, &:focus-visible:not([data-pointer-focus])': { background: vars.bgHover, color: vars.fg, outline: 'none' },
    '&[aria-pressed="true"]': { color: vars.fg },
  },
});
