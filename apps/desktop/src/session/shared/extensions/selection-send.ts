import { fileCiteDraft } from '@gugu/session-shared/markdown';
import { fileRefOf } from './app-runtime-protocol';

/**
 * API 54 `gugu.files.sendSelection({ text, refs, rect, viewport })`: the preinstalled Files App asks the host to open its
 * Send box beside a selection. The host draws it, shows the words it will send (`quote`) and their pills, takes the
 * person's own words and @, and sends into the page's session as the composer does. The App learns only `'sent'` or
 * `'cancelled'`: never the words, a member, a message id. Before any other App may call it, re-review that the person
 * still sees every word the App hands in (`text` goes out as theirs).
 */
export type SelectionSendResult = 'sent' | 'cancelled';
export interface SelectionSendRect { x: number; y: number; width: number; height: number }
/** What the host opens: the App's words and pills as they will be sent, and where (the page's CSS px). */
export interface SelectionSendOpen { draft: string; quote: string; pills: string[]; rect: SelectionSendRect; viewport: { width: number; height: number } }

const MAX_TEXT = 16 * 1024;
const MAX_REFS = 8;

function refuse(code: 'denied' | 'invalid', message: string): never { throw Object.assign(new Error(message), { code }); }

/** The installed identity comes from the host, never the page's arguments. */
export function requirePreinstalledFiles(identity: { id: string; origin?: string }): void {
  if (identity.id !== 'workspace' || identity.origin !== 'preinstalled') refuse('denied', 'Send is only available to the preinstalled Files App');
}

const finite = (...values: unknown[]) => values.every((value) => typeof value === 'number' && Number.isFinite(value));

/** The call's words, pills and place, every file one of this page's working copy; anything else opens nothing. */
export function selectionSendOf(input: Record<string, unknown>, workspace: string | null): SelectionSendOpen {
  if (!workspace) refuse('denied', 'Send needs this page to belong to a session');
  const { text, refs, rect, viewport } = input as { text?: unknown; refs?: unknown; rect?: Record<string, unknown>; viewport?: Record<string, unknown> };
  if (typeof text !== 'string' || text.length > MAX_TEXT) refuse('invalid', `Send takes the selected words as text, at most ${MAX_TEXT} characters`);
  if (!Array.isArray(refs) || refs.length === 0 || refs.length > MAX_REFS) refuse('invalid', `Send takes 1 to ${MAX_REFS} refs`);
  const pills = refs.map((value: { file?: unknown; label?: unknown }) => {
    const ref = fileRefOf(value?.file);
    if (!('workspace' in ref) || ref.workspace !== workspace || !('id' in ref) || typeof ref.id !== 'string' || !ref.id) refuse('denied', 'Send cites only files of this page\'s working copy');
    return { file: { id: ref.id }, label: typeof value.label === 'string' ? value.label : undefined };
  });
  if (!rect || !viewport || !finite(rect.x, rect.y, rect.width, rect.height, viewport.width, viewport.height)) refuse('invalid', 'Send takes the selection\'s rect and the page\'s viewport in CSS px');
  const box = { x: rect.x as number, y: rect.y as number, width: rect.width as number, height: rect.height as number };
  const page = { width: viewport.width as number, height: viewport.height as number };
  if (box.width < 0 || box.height < 0 || page.width <= 0 || page.height <= 0) refuse('invalid', 'Send takes the selection\'s rect and the page\'s viewport in CSS px');
  if (box.x > page.width || box.y > page.height || box.x + box.width < 0 || box.y + box.height < 0) refuse('invalid', 'The selection is not on the page');
  const draft = fileCiteDraft(text, pills);
  return { draft, quote: text.trim(), pills: pills.map(({ file, label }) => `${file.id.replace(/\\/g, '/').split('/').pop()}${label ? ` · ${label}` : ''}`), rect: box, viewport: page };
}

/** What Send sends: the cite's words and pills as `fileCiteDraft` writes them, then the person's own, after a blank line. */
export function selectionSendBody(draft: string, said: string): string {
  const words = said.trim();
  return words ? `${draft}\n\n${words}` : draft;
}
