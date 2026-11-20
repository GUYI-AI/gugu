import { z } from 'zod';
import { groupFileLink, parseGroupFileLink } from '@gugu/core/shared/ui/guguLink';
import { fileRefOf, type AppFileRef } from './app-runtime-protocol';
import type { AnnotationConversation } from '../browser-annotation';

/**
 * A file's selection and the one menu for it (API 60). The host decides what can be done with a selection and does it;
 * whoever shows the file only draws the menu the host gave it, from one table (`selectionMenu`), and hands the selection
 * over on a press:
 * - Copy, when there are words (a phone's sandboxed page has no copy menu of its own);
 * - Cite, the words and a pill per place into the conversation's composer, for the person to go on writing;
 * - Send, the same cite with a line of the person's own, which they write in the host's own box and send themselves.
 * An App's page draws it with the runtime (`gugu.files.showSelection`, the table came with `files.open`), in its own frame;
 * the host's text preview draws the same DOM (selection-menu-dom.ts). A page can press the menu itself: so Cite only drafts
 * and Send only opens the host's box — what a page can do is what `gugu.dispatch` drafts already can.
 */

export const EXTENSION_FILE_SELECTION_METHOD = 'extensions.fileSelection';

/**
 * A place in a file, as a pill's link carries it — the `{ at, label }` of `gugu.dispatch` refs: `at` the place's keys
 * (`{ lines: '3-4' }`, an App's own such as `{ sheet, cell }`), `label` what the pill says after the file's name, in the
 * reader's language. A place of lines may leave its label to the host (「第 3–4 行」).
 */
export interface SelectionPlace { at: Record<string, string>; label?: string }

/** What is picked: its places (one pill each), and the words, when there are any (a code file's quoted as they are, fenced). */
export interface FileSelectionPick { places: SelectionPlace[]; text?: string; code?: boolean }

/** A file named where it lives: a chat folder's by its `gugu-file://` link, a computer's by its absolute path there. */
export interface FileReference { name: string; target: string }

/** Where a pill to one place of the file points: a chat folder's link at that place; a computer's path (its label says where). */
export function placeTarget(file: FileReference, place: SelectionPlace): string {
  const link = parseGroupFileLink(file.target);
  return link ? groupFileLink(link.itemId, { ...(link.version === undefined ? {} : { version: link.version }), at: place.at }) : file.target;
}

/** Where the page's selection is, in the page's CSS px, and the page's size. */
export interface SelectionBox { rect: { x: number; y: number; width: number; height: number }; viewport: { width: number; height: number } }

/** Main → the window that draws the page: the person pressed Cite or Send on this selection. */
export interface FileSelectionAsk extends SelectionBox {
  webContentsId: number;
  action: 'cite' | 'send';
  conversation: AnnotationConversation;
  file: FileReference;
  pick: FileSelectionPick;
}

export type FileSelectionAction = 'copy' | 'cite' | 'send';

/**
 * The conversation a page's selection belongs to: the session whose page it is, else the chat it is drawn in, else none.
 * The one answer for which actions there are, where a cite goes and whose draft an annotation joins.
 */
export function selectionConversationOf(page: { session?: string | null; chat?: string | null }): AnnotationConversation | null {
  if (page.session) return { kind: 'session', sessionId: page.session };
  if (page.chat) return { kind: 'chat', chatId: page.chat };
  return null;
}

/** The menu's words, in the person's language: one source for every place that draws it. */
const WORDS = {
  'zh-CN': { copy: '复制', cite: '引用', send: '发送', sendPlaceholder: '写一句给 agent 的话…' },
  'en-US': { copy: 'Copy', cite: 'Cite', send: 'Send', sendPlaceholder: 'A line for the agent…' },
} as const;
export function selectionWords(locale: string): (typeof WORDS)[keyof typeof WORDS] {
  return locale.startsWith('zh') ? WORDS['zh-CN'] : WORDS['en-US'];
}

export interface SelectionMenuItem { id: FileSelectionAction; label: string }

/**
 * The menu, in order, for a page's file: Copy always (drawn only when a pick has words: `drawnItems`); Cite with a
 * conversation and a file it can name for its readers; Send also needs a surface that can send (a phone's task page cites only).
 */
export function selectionMenu(conversation: AnnotationConversation | null, named: boolean, canSend: boolean, locale: string): SelectionMenuItem[] {
  const words = selectionWords(locale);
  const there = Boolean(conversation && named);
  return (['copy', ...(there ? ['cite' as const] : []), ...(there && canSend ? ['send' as const] : [])] as FileSelectionAction[])
    .map((id) => ({ id, label: words[id] }));
}

/** What is drawn of the menu for a pick: Copy only when it has words. */
export function drawnItems(items: readonly SelectionMenuItem[], words: boolean): SelectionMenuItem[] {
  return items.filter((item) => item.id !== 'copy' || words);
}

/** Where a page's opened file's menu is kept: the file as its place names it. */
export function selectionFileKey(ref: AppFileRef): string {
  return 'workspace' in ref ? `w:${ref.workspace}:${'id' in ref ? ref.id : ''}` : `c:${'id' in ref ? ref.id : ''}`;
}

const finite = z.number().finite();
const word = z.string().min(1).max(200);
const action = z.object({
  action: z.enum(['cite', 'send']),
  file: z.unknown(),
  places: z.array(z.object({ at: z.record(word, word).refine((at) => Object.keys(at).length > 0), label: word.optional() }).strict()).min(1).max(8),
  text: z.string().min(1).max(16 * 1024).optional(),
  code: z.boolean().optional(),
  rect: z.object({ x: finite, y: finite, width: finite.nonnegative(), height: finite.nonnegative() }),
  viewport: z.object({ width: finite.positive(), height: finite.positive() }),
}).strict();

/**
 * `filesSelectionAction`'s argument (the menu pressed on a page), checked: the action, the pick, its file and its box — and
 * the version the page shows (the entry's `version`, when it gave one): what was picked was picked on that one, so its
 * pills point there, not at a newer version that came in since.
 */
export function parseSelectionAction(input: unknown): SelectionBox & { action: 'cite' | 'send'; file: AppFileRef; version?: number; pick: FileSelectionPick } {
  const parsed = action.safeParse(input);
  if (!parsed.success) {
    throw Object.assign(new Error('A selection action is { action: cite | send, file, places: [{ at, label? }] (1–8), text?, code?, rect, viewport } (CSS px)'), { code: 'invalid' });
  }
  const { action: pressed, file, places, text, code, rect, viewport } = parsed.data;
  const version = (file as { version?: unknown } | null)?.version;
  return { action: pressed, file: fileRefOf(file), ...(Number.isSafeInteger(version) && (version as number) > 0 ? { version: version as number } : {}), pick: { places, ...(text ? { text } : {}), ...(code ? { code } : {}) }, rect, viewport };
}
