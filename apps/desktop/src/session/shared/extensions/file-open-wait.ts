import { isWorkspace, type AppFileRef } from './app-runtime-protocol';

/**
 * Whether a page's `files.openWith` shows its file's waiting page before the host resolves it, as a file card's click
 * does: a person's page opening a chat file by id in a chat's panel — not a pick (`ask`), not beside the page (`peek`),
 * not its own named tab, nothing brought forward (`resumed`), the chat known. Unsure is no. One rule for main and phone.
 */
export function mayOpenEarly(call: { person: boolean; ask: boolean; peek: boolean; tab: string | undefined; resumed: boolean; ref: AppFileRef; chat: string | null | undefined }): call is typeof call & { ref: { id: string } } {
  return call.person && !call.ask && !call.peek && call.tab === undefined && !call.resumed && !isWorkspace(call.ref) && 'id' in call.ref && !!call.chat;
}

/** One open through its waiting page, for every asker: begun, resolved, then settled by its page — or, any other way out, taken back. */
export async function openThroughWait<T>(io: { begin(): void; settle(page: T): unknown; fail(): void }, resolve: () => Promise<T | null | undefined>): Promise<T | null | undefined> {
  io.begin();
  let settled = false;
  try {
    const page = await resolve();
    if (page) await io.settle(page);
    settled = !!page;
    return page;
  } finally {
    if (!settled) io.fail();
  }
}
