import type { FileSelectionAsk } from '@shared/extensions/file-selection';
import { selectionCite } from '@/components/preview/quote-preview-file';
import { citeIntoConversation } from '@renderer/lib/editor/cite-into-conversation';
import { notify } from '@/lib/notices';
import { openCommentLine } from './selection-line';

const failed = (error: unknown) => notify({ tier: 'error', title: error instanceof Error ? error.message : String(error) });

/**
 * Cite or Comment pressed on an App page's menu (the runtime drew it in `guest`): a draft in the composer, or the comment
 * box at the selection (`selection-line.tsx`), whose comment joins the conversation's draft. The wire name of Comment
 * stays `send` (API 60).
 */
export function runFileSelection(guest: HTMLElement, container: HTMLElement | null, ask: FileSelectionAsk): void {
  if (ask.action === 'cite') { citeIntoConversation(ask.conversation, selectionCite(ask.conversation, ask.file, ask.pick)).catch(failed); return; }
  // The page's CSS px, scaled to the guest's box (its zoom and the window's included).
  const box = guest.getBoundingClientRect(), scale = box.width / ask.viewport.width;
  openCommentLine(ask.conversation, new DOMRect(box.x + ask.rect.x * scale, box.y + ask.rect.y * scale, ask.rect.width * scale, ask.rect.height * scale), guest,
    { kind: 'file', file: ask.file, places: ask.pick.places, ...(ask.pick.text ? { text: ask.pick.text } : {}) }, container);
}
