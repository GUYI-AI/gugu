import { selectionWords, type FileSelectionAsk } from '@shared/extensions/file-selection';
import type { AnnotationConversation } from '@shared/browser-annotation';
import { selectionCite, type SelectionCite } from '@/components/preview/quote-preview-file';
import { citeIntoConversation } from '@renderer/lib/editor/cite-into-conversation';
import { notify } from '@/lib/notices';
import { i18n } from '@/i18n';
import { openSelectionLine } from './selection-line';

/**
 * A file selection's Send line (file-selection.ts): the host's own box at the selection (`selection-line.tsx`), where the
 * person writes a line and sends it with the selection's cite — whoever drew the menu (an App page's runtime, the host's
 * text preview), only this box sends.
 */
const failed = (error: unknown) => notify({ tier: 'error', title: error instanceof Error ? error.message : String(error) });

/** The Send line at `at` (this window's px), kept inside `within`. */
export function openSendLine({ conversation, cite, ...place }: { at: DOMRect; within: HTMLElement; container: HTMLElement | null; conversation: AnnotationConversation; cite: SelectionCite }): void {
  const words = selectionWords(i18n.language);
  openSelectionLine({ ...place, words: { placeholder: words.sendPlaceholder, submit: words.send }, save: (text, send) => send(conversation, cite, text) });
}

/** Cite or Send pressed on an App page's menu (the runtime drew it in `guest`): a draft, or the Send line at the selection. */
export function runFileSelection(guest: HTMLElement, container: HTMLElement | null, ask: FileSelectionAsk): void {
  const cite = selectionCite(ask.conversation, ask.file, ask.pick);
  if (ask.action === 'cite') { citeIntoConversation(ask.conversation, cite).catch(failed); return; }
  // The page's CSS px, scaled to the guest's box (its zoom and the window's included).
  const box = guest.getBoundingClientRect(), scale = box.width / ask.viewport.width;
  openSendLine({ at: new DOMRect(box.x + ask.rect.x * scale, box.y + ask.rect.y * scale, ask.rect.width * scale, ask.rect.height * scale), within: guest, container, conversation: ask.conversation, cite });
}
