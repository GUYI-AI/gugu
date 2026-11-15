import { style } from '@vanilla-extract/css'

// The exposed composer column contains both portals. Its top is also the top of
// the first content band, regardless of which portal appended that band.
export const composerBandClearance = style({
  selectors: {
    ':has([data-composer-top-band]:not(:empty)) > &': { marginBottom: 0 },
  },
})
