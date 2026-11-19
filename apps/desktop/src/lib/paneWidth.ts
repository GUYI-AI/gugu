import { readInterface, takeLegacyInterface, writeInterface } from './viewStateTable'

/**
 * @@@pane-width - a resizable column's width is the person's, and it is that column's own: one setting of the device (lib/
 * viewStateTable), named by the column, in px (a share would change with the window). The column declares its width
 * before anyone drags (`initial`) and its bounds; a stored width is read back inside them. Columns never share a name, so
 * dragging one never moves another. Pages beside each other in a pane (tabs) keep theirs with the page instead
 * (`@@@side-width`, pane-layout-store).
 */
export type PaneWidth = { readonly id: string; readonly initial: number; readonly min: number; readonly max: number }

/** Declares a column's width setting; a value kept in localStorage under `id` before the table moves over once. */
export function definePaneWidth(pane: PaneWidth): PaneWidth {
  takeLegacyInterface(pane.id, pane.id, Number)
  return pane
}

/** Inside the column's bounds, whole px; anything that is not a number is its initial width. */
export function clampPaneWidth(pane: PaneWidth, width: number): number {
  if (!Number.isFinite(width)) return pane.initial
  return Math.min(pane.max, Math.max(pane.min, Math.round(width)))
}

/** The width the person left the column at, or its initial width. */
export function readPaneWidth(pane: PaneWidth): number {
  const stored = readInterface<number>(pane.id)
  return typeof stored === 'number' && Number.isFinite(stored) && stored > 0 ? clampPaneWidth(pane, stored) : pane.initial
}

/** Keeps the width the person chose (a drag let go, a key step). */
export function writePaneWidth(pane: PaneWidth, width: number): void {
  writeInterface(pane.id, clampPaneWidth(pane, width))
}
