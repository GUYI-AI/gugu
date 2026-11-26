import { style } from '@vanilla-extract/css';
import { vars } from '@session-ui/theme/core/contract/contract.css';
import { tokenVars } from '@session-ui/theme/tokens.css';

export const wrapper = style({ display: 'inline' });

/** 22px tall: it sits in the 24px text line without pushing the lines apart. */
export const pill = style({
  counterIncrement: 'inline-image',
  display: 'inline-flex',
  alignItems: 'center',
  gap: '0.25rem',
  height: '22px',
  padding: '0 6px 0 2px',
  verticalAlign: '-3px',
  borderRadius: tokenVars.radiusSm,
  border: `1px solid ${vars.border}`,
  backgroundColor: vars.surfaceBase,
  fontSize: '14px',
  lineHeight: '20px',
  fontWeight: 500,
  color: vars.foreground,
  cursor: 'pointer',
  userSelect: 'none',
  selectors: {
    '&:hover': { backgroundColor: vars.surfaceBaseHover },
    '&::after': { content: 'attr(data-label) " " counter(inline-image)', whiteSpace: 'nowrap' },
  },
});

export const pillSelected = style({ boxShadow: `0 0 0 2px ${vars.foregroundInfo}` });

export const thumb = style({
  display: 'block',
  width: '16px',
  height: '16px',
  flexShrink: 0,
  borderRadius: '4px',
  objectFit: 'cover',
  backgroundColor: vars.surfaceBaseEmphasis,
});

export const thumbIcon = style({ display: 'block', width: '16px', height: '16px', flexShrink: 0, color: vars.foregroundMuted });

export const preview = style({
  position: 'fixed',
  padding: '6px',
  borderRadius: '12px',
  border: `1px solid ${vars.border}`,
  backgroundColor: vars.surfaceElevated,
  boxShadow: `0 8px 24px color-mix(in srgb, ${vars.foreground} 16%, transparent)`,
  pointerEvents: 'none',
});

export const previewImage = style({
  display: 'block',
  maxWidth: '240px',
  maxHeight: '200px',
  borderRadius: '8px',
  objectFit: 'contain',
});
