import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { agentQuotaReason } from '@gugu/core/shared/agentQuotaReason';
import { db } from '@main/db/client';
import { kv } from '@main/db/schema';
import type { AgentEvent } from '@shared/core/agents/agentEvents';

const keyFor = (sessionId: string) => `session-error-notice:${sessionId}`;
type ErrorNotice = { fingerprint: string; seen: boolean };

function read(sessionId: string): ErrorNotice | null {
  const row = db.select({ value: kv.value }).from(kv).where(eq(kv.key, keyFor(sessionId))).get();
  if (!row) return null;
  const value: unknown = JSON.parse(row.value);
  return value && typeof value === 'object' && 'fingerprint' in value && typeof value.fingerprint === 'string'
    && 'seen' in value && typeof value.seen === 'boolean' ? value as ErrorNotice : null;
}

function write(sessionId: string, notice: ErrorNotice): void {
  const value = JSON.stringify(notice), updatedAt = Date.now();
  db.insert(kv).values({ key: keyFor(sessionId), value, updatedAt })
    .onConflictDoUpdate({ target: kv.key, set: { value, updatedAt } }).run();
}

/** Only persistent quota exhaustion is acknowledged across retries; transient/unknown failures still notify. */
export function quotaErrorUnseen(sessionId: string, event: AgentEvent | undefined): boolean {
  const message = event?.payload.message;
  const reason = agentQuotaReason(message);
  if (!reason || reason === 'rate-limited') {
    clearErrorNotice(sessionId);
    return true;
  }
  // A provider's reset sentence distinguishes quota periods without guessing a time or storing its diagnostic.
  const reset = message?.match(/\bresets?\b[^\n]*/i)?.[0].trim().toLowerCase() ?? null;
  const fingerprint = createHash('sha256').update(JSON.stringify([event?.providerId, event?.payload.modelId, reason, reset])).digest('hex');
  const previous = read(sessionId);
  const seen = previous?.fingerprint === fingerprint && previous.seen;
  write(sessionId, { fingerprint, seen });
  return !seen;
}

export function acknowledgeErrorNotice(sessionId: string): void {
  const notice = read(sessionId);
  if (notice && !notice.seen) write(sessionId, { ...notice, seen: true });
}

export function clearErrorNotice(sessionId: string): void {
  db.delete(kv).where(eq(kv.key, keyFor(sessionId))).run();
}
