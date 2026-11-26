import type { FileSelectionAsk } from '@shared/extensions/file-selection';
import { openCommentLine } from './selection-line';

/**
 * Comment pressed on an App page's menu (the runtime drew it in `guest`): the comment box at the selection
 * (`selection-line.tsx`), whose comment joins the conversation's draft. The wire name of Comment is `send` (API 60).
 */
export function runFileSelection(guest: HTMLElement, container: HTMLElement | null, ask: FileSelectionAsk): void {
  // The page's CSS px, scaled to the guest's box (its zoom and the window's included).
  const box = guest.getBoundingClientRect(), scale = box.width / ask.viewport.width;
  openCommentLine(ask.conversation, new DOMRect(box.x + ask.rect.x * scale, box.y + ask.rect.y * scale, ask.rect.width * scale, ask.rect.height * scale), guest,
    { kind: 'file', file: ask.file, places: ask.pick.places, ...(ask.pick.text ? { text: ask.pick.text } : {}) }, container);
}
