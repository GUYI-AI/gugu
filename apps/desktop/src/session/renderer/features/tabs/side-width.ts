/**
 * How wide a page opened beside another starts (spec session-page「并排」; owner 11-07: one rule for every page on the
 * right). A side page — an App's host settings form — starts at `SIDE_PAGE_WIDTH_PX` (a chat's Details no longer: it is
 * the browser card's peer, 界面减法); an App's own page at its manifest `sideWidth`; a page that declares nothing (a file, a topic) is
 * the other page's peer: half each. Never more than half. A dragged divider wins while the pair lasts; double-clicking it
 * comes back here.
 */
export const SIDE_PAGE_WIDTH_PX = 360;

/** The share (percent) a page declaring `px` takes of a cut `extent` px wide. */
export const declaredShare = (px: number, extent: number): number => Math.min(50, (px / extent) * 100);
