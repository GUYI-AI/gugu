import type { TranscriptTurn } from '@gugu/session-core/acp';
import { indexNativePrompts, nativePromptDigest, sameHostPrompt, type HostPrompt } from '@gugu/session-core/acp/native-prompt';
import { db, type AppDb } from '@main/db/client';
import { kv } from '@main/db/schema';
import { eq } from 'drizzle-orm';

type Tx = Pick<AppDb, 'select' | 'insert'>;
const key = (sessionId: string, digest: string) => `native-prompt:${sessionId}:${digest}`;
/** Receipts kept before files were kept with them hold the words alone. */
const read = (value: string): HostPrompt | null => {
  const kept = JSON.parse(value) as string | HostPrompt | null;
  return typeof kept === 'string' ? { text: kept } : kept;
};

/**
 * What the person sent with the prompts its agent recorded differently (`native-prompt.ts`): a live user message
 * carries the receipt of the text sent, kept here by it. A receipt seen with two different originals is kept as unknown
 * (null), as `indexNativePrompts` does.
 */
export function keepNativePromptReceipts(sessionId: string, turn: TranscriptTurn, tx: Tx = db): void {
  for (const [digest, prompt] of indexNativePrompts(turn.items)) {
    const id = key(sessionId, digest);
    const kept = tx.select({ value: kv.value }).from(kv).where(eq(kv.key, id)).get();
    const value = JSON.stringify(kept && !sameHostPrompt(read(kept.value), prompt) ? null : prompt);
    tx.insert(kv).values({ key: id, value }).onConflictDoUpdate({ target: kv.key, set: { value } }).run();
  }
}

/** The host original of a recorded prompt, by its receipt: undefined = no receipt, null = cannot be told. */
export function nativePromptReceipt(sessionId: string, digest: string): HostPrompt | null | undefined {
  const kept = db.select({ value: kv.value }).from(kv).where(eq(kv.key, key(sessionId, digest))).get();
  return kept ? read(kept.value) : undefined;
}

/** The host's words for a recorded prompt's native text: undefined = no receipt, null = cannot be told. */
export function nativePromptOriginal(sessionId: string, nativeText: string): string | null | undefined {
  const prompt = nativePromptReceipt(sessionId, nativePromptDigest(nativeText));
  return prompt === undefined || prompt === null ? prompt : prompt.text;
}
