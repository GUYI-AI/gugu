import { fileCite, pillCite } from '@gugu/session-shared/markdown';
import { composeInChat } from '@/session/shared/extensions/app-send-core';
import { APP_COMPOSE_EVENT, type AppComposeRef } from '@/session/shared/extensions/app-runtime-protocol';
import type { FileViewerSelection } from '@/session/shared/preview/file-viewer-menu';
import { parseGroupFileLink } from '@gugu/core/shared/ui/guguLink';
import type { AnnotationConversation } from '@/session/shared/browser-annotation';
import { placeTarget, type FileReference, type FileSelectionPick, type SelectionPlace } from '@/session/shared/extensions/file-selection';
import { getRendererSession } from '@/lib/sessionPublication';
import { i18n } from '@/i18n';
import { codeQuote } from '../../../preinstalled-apps/workspace/code-quote.js';

export function selectedTextQuote(selection: FileViewerSelection): string {
  return selection.code ? codeQuote(selection.text) : selection.text.split('\n').map((line) => `> ${line}`).join('\n');
}

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

/**
 * What a cite puts in a composer: a pill per place (the file's name and where), as one draft. The pill's link names the
 * lines, so the words picked are not quoted beside it. A computer's file cited into a chat has no pill: there the words
 * are quoted, the file named by its path (`quote`).
 */
export interface SelectionCite { quote: string; refs: AppComposeRef[]; draft: string }

/** A cite of a file named where it lives (`FileReference`); without places, of the file whole. */
export function selectionCite(conversation: AnnotationConversation, file: FileReference, pick: FileSelectionPick | null): SelectionCite {
  const places = pick?.places.length ? pick.places : null;
  const refs = places ? places.map((place) => {
    const label = placeLabel(place);
    return { label: label ? `${file.name} (${label})` : file.name, link: placeTarget(file, place) };
  }) : [{ label: file.name, link: file.target }];
  // A chat's pills are its folder's files; a file on a computer is named in words, its path written out — a chat has no
  // pill that opens it (a session's composer does: its working copy is where the path is read).
  if (conversation.kind === 'chat' && !parseGroupFileLink(file.target)) {
    const quote = pick?.text ? selectedTextQuote({ text: pick.text, ...(pick.code ? { code: true } : {}) }) : '';
    const named = [quote, ...refs.map(({ label, link }) => `${label}: ${link}`)].filter(Boolean).join('\n\n');
    return { quote: named, refs: [], draft: named };
  }
  return { quote: '', refs, draft: pillCite('', refs.map(({ label, link }) => ({ label, target: link }))).draft };
}

/** Use the App file-reference producer and its existing draft delivery, including membership and version checks. */
export async function quoteChatFile(itemId: string, version: number, selection: FileViewerSelection | null): Promise<void> {
  const session = getRendererSession();
  if (!session) throw new Error('Sign in to quote this file');
  const detail = await composeInChat({ account: async () => ({ token: session.access_token, userId: session.user.id }) }, {
    text: '',
    refs: [{
      file: { id: itemId },
      version,
      ...(selection ? { at: selection.at, label: selectionPosition(selection) } : {}),
    }],
  });
  document.dispatchEvent(new CustomEvent(APP_COMPOSE_EVENT, { detail, bubbles: true }));
}

/** The same task-file reference text in desktop and phone composers. */
export function workspaceFileQuote(path: string, selection: FileViewerSelection | null): string {
  return fileCite('', [{ file: { id: path }, label: selection ? selectionPosition(selection) : '' }]).draft;
}
