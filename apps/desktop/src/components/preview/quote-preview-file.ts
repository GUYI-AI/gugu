import type { FileViewerSelection } from '@/session/shared/preview/file-viewer-menu';
import type { FileSelectionPick, SelectionPlace } from '@/session/shared/extensions/file-selection';
import { i18n } from '@/i18n';

/** The place as the Files App says it (its `line` / `lines` strings): 「第 10–11 行」, "Lines 10–11". */
export function selectionPosition(selection: FileViewerSelection): string {
  const [first, last = first] = selection.at?.lines?.split('-') ?? [];
  if (!first) return '';
  return first === last ? i18n.t('fileCite.line', { first, ns: 'messaging' }) : i18n.t('fileCite.lines', { first, last, ns: 'messaging' });
}

/** A file menu's selection (`FileViewerSelection`) as the selection menu picks it. */
export function viewerPick(selection: FileViewerSelection): FileSelectionPick {
  return { places: selection.at ? [{ at: selection.at }] : [], ...(selection.text ? { text: selection.text } : {}), ...(selection.code ? { code: true } : {}) };
}

/** Source lines as a place (`{ lines: '3-4' }`, as a pill's link and the Files App write them). */
export function linesPlace(first: number, last: number): SelectionPlace {
  return { at: { lines: first === last ? `${first}` : `${first}-${last}` } };
}

/** What a place is called after the file's name: its own label, or the host's for lines (「第 3–4 行」); a place of other keys has its App's. */
export function placeLabel(place: SelectionPlace): string {
  return place.label ?? (place.at.lines ? selectionPosition({ text: '', at: { lines: place.at.lines } }) : '');
}
