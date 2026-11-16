import { style } from '@vanilla-extract/css';
import { vars } from '@session-chat/styles/theme.css';

/** A small `FileMark` (diff header, resource link): muted color, no flex shrink. */
export const genericFileIcon = style({
  color: vars.fgMuted,
  flexShrink: 0,
});
