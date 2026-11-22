import { createVar, keyframes, style } from '@vanilla-extract/css';

export const distance = createVar();
export const duration = createVar();
/** How much of the title's end the row's actions cover while they are shown (0 when nothing is drawn over it). */
export const cover = createVar();

const revealTitle = keyframes({ to: { transform: `translateX(calc(-1 * ${distance}))` } });
const revealEnd = keyframes({
  '75%': { maskSize: '100% 100%' },
  to: { maskSize: 'calc(100% + 1em) 100%' },
});

const motion = {
  animationDuration: duration,
  animationDelay: '350ms',
  animationTimingFunction: 'cubic-bezier(0.49, 0.6, 0.7, 1)',
  animationFillMode: 'forwards',
} as const;

// The row's actions are visible (pointer on the row, or one of them focused): the title fades out before them.
const covered = '[data-sidebar-row]:is(:hover, [data-actions-focused])';
// The title reveals its end: pointer on the row, or keyboard focus on the row or on the title's own button.
const revealing = '[data-sidebar-row]:is(:hover, :focus-visible:not([data-pointer-focus]))';
const revealingButton = '[data-sidebar-row] button:focus-visible:not([data-pointer-focus])';

export const viewport = style({
  display: 'block', minWidth: 0, flex: 1, overflow: 'hidden', whiteSpace: 'nowrap',
  maskRepeat: 'no-repeat',
  selectors: {
    '&[data-overflow]': {
      maskImage: 'linear-gradient(to right, black calc(100% - 1em), transparent)',
    },
    // The actions carry no backing (it could not match a translucent window material); the title itself
    // fades to transparent where they begin, so under them is always the row's own surface.
    [`${covered} &[data-reveal], ${revealing} &[data-reveal], ${revealingButton} &[data-reveal]`]: {
      maskImage: `linear-gradient(to right, black calc(100% - ${cover} - 1em), transparent calc(100% - ${cover}))`,
    },
  },
  '@media': {
    '(prefers-reduced-motion: no-preference)': {
      selectors: {
        [`${revealing} &[data-reveal], ${revealingButton} &[data-reveal]`]: {
          ...motion, animationName: revealEnd,
        },
      },
    },
  },
});

export const content = style({
  display: 'block', width: 'max-content', minWidth: '100%',
  // Remeasuring replaces this track; keep pointer input on its stable viewport.
  pointerEvents: 'none',
  '@media': {
    '(prefers-reduced-motion: no-preference)': {
      selectors: {
        [`${revealing} ${viewport}[data-reveal] &`]: {
          ...motion, animationName: revealTitle,
        },
        [`${revealingButton} ${viewport}[data-reveal] &`]: {
          ...motion, animationName: revealTitle,
        },
      },
    },
  },
});
