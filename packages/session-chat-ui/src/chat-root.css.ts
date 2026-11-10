/**
 * chat-root.css.ts — layout classes for ChatRoot.tsx.
 *
 * Previously all inline Tailwind utilities. Now typed VE style objects.
 * The `contentClass` prop API is preserved — hosts who pass a custom string
 * should now pass a VE class or a raw CSS class string.
 */

import { style } from '@vanilla-extract/css';
import { vars } from './styles/theme.css';
import {
  CHAT_CONTENT_GUTTER_PX,
  CHAT_CONTENT_MAX_WIDTH_REM,
  CHAT_CONTENT_MAX_WIDTH_WIDE_REM,
  CHAT_CONTENT_WIDE_BREAKPOINT_REM,
  PIN_SUMMARY_GAP,
} from './layout-geometry';

/** Max-width of the centered content column — matches user message cards. */
const CONTAINER_WIDTH = `${CHAT_CONTENT_MAX_WIDTH_REM}rem`;
const CONTAINER_WIDTH_WIDE = `${CHAT_CONTENT_MAX_WIDTH_WIDE_REM}rem`;

/**
 * 宽屏档 —— 三处内容列宽度**一起**换档,见 layout-geometry 的 @@@composer-size-invariance。
 *
 * ⚠️ 三处必须同进同退:transcript(消息卡)、hero、composer 槽位。只放宽 composer 的话,
 * 底部那张卡就比它上面的用户消息卡宽出 96px —— 而这条内容列存在的全部意义就是它们对齐。
 */
const WIDE = `screen and (min-width: ${CHAT_CONTENT_WIDE_BREAKPOINT_REM}rem)`;
const widenAtXl = { '@media': { [WIDE]: { maxWidth: CONTAINER_WIDTH_WIDE } } } as const;

/**
 * Horizontal gutter applied to the scroll container and
 * composer slot so the centered content column keeps breathing room from the
 * viewport edge once the viewport is narrower than CONTAINER_WIDTH.
 */
const CONTENT_GUTTER = `${CHAT_CONTENT_GUTTER_PX}px`;

/** Outer clip container. */
export const outerClip = style({
  position: 'relative',
  height: '100%',
  width: '100%',
  overflow: 'hidden',
  // Base font so chrome text (headers, tool/thinking/plan rows) inherits the
  // sans font rather than the browser default. Prose/code set font-family
  // explicitly; this only affects elements that rely on inheritance.
  fontFamily: vars.fontSans,
  colorScheme: vars.colorScheme,
});

/** Scroll container — the element ChatRoot attaches its scroll listener to. */
export const scrollContainer = style({
  position: 'relative',
  height: '100%',
  width: '100%',
  overflowX: 'hidden',
  overflowY: 'auto',
  // Reserve a stable gutter so the scrollbar appearing/disappearing does not
  // change contentRect.width, which would trigger prose re-wrap ("flash") and
  // transient height desync ("overlap") on every thinking expand/collapse.
  scrollbarGutter: 'stable',
  // Horizontal breathing room so the centered content column never touches the
  // viewport edge when the viewport is narrower than CONTAINER_WIDTH. Applied on
  // this flow ancestor (not the content column) so the width probe and the
  // absolutely-positioned rows both shrink correctly. The pinned overlay and
  // composer slot carry the same gutter to stay aligned.
  paddingLeft: CONTENT_GUTTER,
  paddingRight: CONTENT_GUTTER,
});

/** `embedded`: a few rows inside another page's column — that column already has its own edge. */
export const scrollContainerEmbedded = style({
  paddingLeft: 0,
  paddingRight: 0,
});

/** Virtualizer canvas — positions all rows absolutely inside this container. */
export const canvas = style({
  position: 'relative',
});

/**
 * Zero-height width probe — carries `contentClass` so it reports the capped
 * content-column width. The width ResizeObserver targets this instead of the
 * virtualizer canvas so it only fires on genuine layout-width changes (viewport
 * resize or gutter toggle), never on canvas height mutations driven by streaming
 * or expand/collapse tween updates.
 */
export const widthProbeClass = style({
  height: 0,
  overflow: 'hidden',
  pointerEvents: 'none',
});

/** Per-unit row wrapper — translates each row to its virtualizer Y position. */
export const unitRowWrapper = style({
  position: 'absolute',
  top: 0,
  left: 0,
  width: '100%',
  willChange: 'transform',
  contain: 'layout paint style',
});

/**
 * A pin lane (@@@sticky-user-lanes in ChatRoot): spans its turn, so its sticky element stays at the top
 * while the turn is on screen and is pushed off by the next lane. Clicks pass through everywhere but
 * the row itself and a shown summary.
 *
 * Every row wrapper is its own stacking context at z-index auto (contain: paint, will-change), so
 * nothing inside a reply (KaTeX struts, code blocks, positioned spans) can rise above a lane. A user
 * lane sits above activity lanes, whose sticky headers reserve room below the user's summary.
 */
export const pinLane = style({
  zIndex: 1,
  pointerEvents: 'none',
});
export const pinMessageLane = style({ zIndex: 2 });
/** Whatever the message positions or raises inside itself stays under its own summary. */
export const pinMessageRow = style({ isolation: 'isolate', marginTop: 'calc(-1 * var(--pin-layer-h))' });

/** The semantic strip reaches the scroller edges, outside the centered text column. */
export const activityPinLane = style({ contain: 'layout style' });

/** The sticking element inside a lane; its backdrop is opaque only while stuck. */
export const pinSticky = style({
  // `top` is per row (ChatRoot): the card lands on the pin line whatever the row's collapsed top gap.
  position: 'sticky',
  pointerEvents: 'auto',
  '@media': { '(prefers-reduced-motion: reduce)': {
    selectors: { '[data-pin-leaving="true"] &': { visibility: 'hidden' } },
  } },
});


/** A normal bubble has no full-width card behind it. Protect the pinned row once it actually sticks. */
export const pinBackdrop = style({
  position: 'absolute', inset: 0, zIndex: -1, pointerEvents: 'none',
  background: vars.bg, opacity: 0,
  // The frame scheduler supplies this state from existing lane geometry. Older
  // Android WebViews cannot evaluate scroll-state container queries.
  selectors: {
    '[data-pin-stuck="true"] &': { opacity: 1 },
  },
  // A soft edge rather than a rule: says rows scroll beneath it without drawing a line across the page.
  boxShadow: `0 8px 12px -10px color-mix(in srgb, ${vars.fg} 22%, transparent)`,
});

/**
 * A user message's summary sticks in front of its own message (@@@pin-cover in ChatRoot): resting, it lies
 * exactly over the message's first two lines; stuck, the message slides on beneath it. It is drawn only
 * while stuck, with its opaque backdrop, so the pinned strip never shows anything behind it.
 */
export const pinSummaryLayer = style({
  // Takes no room: the message row after it moves up by its height (pinMessageRow). A negative margin here
  // would instead let the sticky box run past its lane's end by that much before it is pushed off.
  height: 'var(--pin-layer-h)',
  boxSizing: 'border-box',
  paddingBottom: PIN_SUMMARY_GAP,
  zIndex: 1,
  visibility: 'hidden',
  pointerEvents: 'none',
  selectors: { '[data-pin-stuck="true"] > &': { visibility: 'visible', pointerEvents: 'auto' } },
});

/** Page-colored, square strip, including its seam so body text cannot peek between the two pins. */
export const activityPinBackdrop = style({
  right: 'auto', boxShadow: 'none',
  borderBottom: `1px solid color-mix(in srgb, ${vars.fgMuted} 16%, transparent)`,
});

/**
 * Default content centering class.
 * Replaces `mx-auto w-full max-w-2xl` from Tailwind.
 * Hosts can override via the `contentClass` prop.
 */
export const defaultContentClass = style({
  marginLeft: 'auto',
  marginRight: 'auto',
  width: '100%',
  maxWidth: CONTAINER_WIDTH,
  ...widenAtXl,
});

/**
 * Content overlay slot — non-scrolling cover above the transcript/scroll,
 * below the composer. Click-through by default so an empty/transparent overlay
 * never blocks scrolling; host content opts into pointer-events as needed.
 * z-index 15: above the pin lanes in the scroller, below composerSlotClass (20).
 */
export const contentOverlaySlotClass = style({
  position: 'absolute',
  inset: 0,
  zIndex: 15,
  pointerEvents: 'none',
});

/**
 * Composer slot — sticky positioning layer only. Transparent so the scrollbar
 * at the viewport edge remains fully visible.
 */
export const composerSlotClass = style({
  position: 'sticky',
  bottom: 0,
  left: 0,
  right: 0,
  width: '100%',
  zIndex: 20,
  // No backing of its own (owner 2026-10-25: the area reads as empty space, messages scroll past
  // behind it); only the cards inside draw a background. Outside the inner column, pointer and
  // wheel events reach the messages.
  pointerEvents: 'none',
  // Match the scroll container gutter so the composer column aligns with the
  // message column when the viewport is narrower than CONTAINER_WIDTH.
  paddingLeft: CONTENT_GUTTER,
  paddingRight: CONTENT_GUTTER,
});

/**
 * Centered composer slot layer used for new/empty conversations. The layer
 * covers the transcript while letting only the hero/composer children receive
 * input, so the host keeps one stable portal target across placements.
 */
export const composerSlotCenteredClass = style({
  position: 'absolute',
  inset: 0,
  zIndex: 20,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  width: '100%',
  paddingLeft: CONTENT_GUTTER,
  paddingRight: CONTENT_GUTTER,
  pointerEvents: 'none',
});

export const composerSlotAnimatingClass = style({
  transition: 'transform 420ms cubic-bezier(0.16, 1, 0.3, 1)',
});

export const heroSlotClass = style({
  marginBottom: '1rem',
  width: '100%',
  maxWidth: CONTAINER_WIDTH,
  ...widenAtXl,
  pointerEvents: 'auto',
  transition: 'opacity 260ms ease-out, transform 360ms cubic-bezier(0.16, 1, 0.3, 1)',
});

export const heroSlotVisibleClass = style({
  position: 'relative',
  opacity: 1,
  transform: 'translateY(0)',
});

export const heroSlotHiddenClass = style({
  position: 'absolute',
  opacity: 0,
  transform: 'translateY(8px)',
  pointerEvents: 'none',
});

/**
 * Inner centering wrapper inside the composer slot — constrains the composer
 * to the same max-width as the content column so it aligns with user message
 * cards, with an 8px bottom gap. It has no backing: the cards portaled into it draw their own.
 * This is the element exposed as `view.composerSlot` (portal target).
 */
export const composerSlotInnerClass = style({
  marginLeft: 'auto',
  marginRight: 'auto',
  width: '100%',
  maxWidth: CONTAINER_WIDTH,
  ...widenAtXl,
  paddingBottom: '8px',
  pointerEvents: 'auto',
});

export const composerSlotInnerCenteredClass = style({
  paddingBottom: 0,
});
