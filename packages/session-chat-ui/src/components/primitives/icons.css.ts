import { style } from '@vanilla-extract/css';

/** A small `FileMark` (diff header, resource link): no flex shrink. Its colour is the file icon's own. */
export const genericFileIcon = style({
  flexShrink: 0,
});
