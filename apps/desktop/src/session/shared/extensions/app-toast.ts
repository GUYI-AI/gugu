import { z } from 'zod';
import { APP_TOAST_INTERVAL_MS, APP_TOAST_MAX } from './bridge-protocol';
import type { ExtensionHostAction } from './host-actions';

/**
 * #1925 (API 44) `gugu.toast(text)`, one rule for both hosts (the desktop's main; the phone's App host from API 49): a short
 * line in the host's own toast, as the host says 「更改已保存」 after a save. No capability, because it can say nothing beyond what the page could show itself, and only while the person looks at it:
 * - a page the person works (not an agent's), on screen and focused now;
 * - text alone — one line, no control character, at most `APP_TOAST_MAX` characters once trimmed; no action, link or icon;
 * - at most one every `APP_TOAST_INTERVAL_MS` for each App, else `rate-limited` (a refused toast does not count).
 */
const coded = (code: 'denied' | 'invalid' | 'rate-limited', message: string) => Object.assign(new Error(message), { code });

const textSchema = z.strictObject({
  text: z.string().trim().min(1).max(APP_TOAST_MAX).refine((text) => !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(text)),
});

const last = new Map<string, number>();

export async function appToast(
  page: { extensionId: string; person: boolean; onScreen: boolean; focused: () => boolean },
  input: unknown,
  act: (action: ExtensionHostAction) => Promise<unknown>,
  now: () => number = Date.now,
): Promise<void> {
  const parsed = textSchema.safeParse(input);
  if (!parsed.success) throw coded('invalid', `gugu.toast takes one line of text, 1 to ${APP_TOAST_MAX} characters`);
  if (!page.person) throw coded('denied', 'A toast is the person\'s: a page an agent works shows none');
  if (!page.onScreen || !page.focused()) throw coded('denied', 'A toast shows only while the page is on screen and focused');
  const at = now();
  const before = last.get(page.extensionId);
  if (before !== undefined && at - before < APP_TOAST_INTERVAL_MS) throw coded('rate-limited', `One toast every ${APP_TOAST_INTERVAL_MS / 1000} s`);
  last.set(page.extensionId, at);
  await act({ kind: 'toast', text: parsed.data.text });
}

/** Tests only. */
export function forgetToastsForTest(): void {
  last.clear();
}
