import type { TranscriptTurn } from '@gugu/session-core/acp';
import { indexNativePrompts, nativePromptDigest } from '@gugu/session-core/acp/native-prompt';
import { db, type AppDb } from '@main/db/client';
import { kv } from '@main/db/schema';
import { eq } from 'drizzle-orm';

type Tx = Pick<AppDb, 'select' | 'insert'>;
const key = (sessionId: string, digest: string) => `native-prompt:${sessionId}:${digest}`;

/**
 * The host's words for the prompts its agent recorded differently (`native-prompt.ts`): a live user message carries
 * the receipt of the text sent, kept here by it. A receipt seen with two different originals is kept as unknown (null),
 * as `indexNativePrompts` does.
 */
export function keepNativePromptReceipts(sessionId: string, turn: TranscriptTurn, tx: Tx = db): void {
  for (const [digest, text] of indexNativePrompts(turn.items)) {
    const id = key(sessionId, digest);
    const kept = tx.select({ value: kv.value }).from(kv).where(eq(kv.key, id)).get();
    const value = JSON.stringify(kept && JSON.parse(kept.value) !== text ? null : text);
    tx.insert(kv).values({ key: id, value }).onConflictDoUpdate({ target: kv.key, set: { value } }).run();
  }
}

/** The host original of a recorded prompt: undefined = no receipt, null = cannot be told. */
export function nativePromptOriginal(sessionId: string, nativeText: string): string | null | undefined {
  const kept = db.select({ value: kv.value }).from(kv).where(eq(kv.key, key(sessionId, nativePromptDigest(nativeText)))).get();
  return kept ? JSON.parse(kept.value) as string | null : undefined;
}
