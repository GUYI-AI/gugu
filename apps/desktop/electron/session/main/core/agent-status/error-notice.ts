import { createHash } from 'node:crypto';
import { desc, eq, sql } from 'drizzle-orm';
import { agentQuotaReason } from '@gugu/core/shared/agentQuotaReason';
import { db } from '@main/db/client';
import { kv, sessions, sessionTurns } from '@main/db/schema';
import type { AgentEvent } from '@shared/core/agents/agentEvents';

const keyFor = (sessionId: string) => `session-error-notice:${sessionId}`;
type ErrorNotice = { current: string | null; acknowledged: string[] };

function read(sessionId: string): ErrorNotice | null {
  const row = db.select({ value: kv.value }).from(kv).where(eq(kv.key, keyFor(sessionId))).get();
  if (!row) return null;
  const value: unknown = JSON.parse(row.value);
  return value && typeof value === 'object' && 'current' in value && (value.current === null || typeof value.current === 'string')
    && 'acknowledged' in value && Array.isArray(value.acknowledged) && value.acknowledged.every(key => typeof key === 'string') ? value as ErrorNotice : null;
}

function write(sessionId: string, notice: ErrorNotice): void {
  const value = JSON.stringify(notice), updatedAt = Date.now();
  db.insert(kv).values({ key: keyFor(sessionId), value, updatedAt })
    .onConflictDoUpdate({ target: kv.key, set: { value, updatedAt } }).run();
}

function fingerprint(message: string | undefined, providerId?: string, modelId?: string): string | null {
  const reason = agentQuotaReason(message);
  if (!reason || reason === 'rate-limited') return null;
  // A provider's reset sentence distinguishes quota periods without guessing a time or storing its diagnostic.
  const reset = message?.match(/\bresets?\b[^\n]*/i)?.[0].trim().toLowerCase() ?? null;
  return createHash('sha256').update(JSON.stringify([providerId, modelId, reason, reset])).digest('hex');
}

/** Only persistent quota exhaustion is acknowledged across retries; transient/unknown failures still notify. */
export function quotaErrorUnseen(sessionId: string, event: AgentEvent | undefined): boolean {
  const key = fingerprint(event?.payload.message, event?.providerId, event?.payload.modelId);
  const previous = read(sessionId);
  const acknowledged = previous?.acknowledged ?? [];
  if (key || previous) write(sessionId, { current: key, acknowledged });
  return key === null || !acknowledged.includes(key);
}

export function acknowledgeErrorNotice(sessionId: string): void {
  const notice = read(sessionId);
  if (notice) {
    if (notice.current && !notice.acknowledged.includes(notice.current)) write(sessionId, { ...notice, acknowledged: [...notice.acknowledged, notice.current] });
    return;
  }
  // Upgrading an existing failed session must not require one extra failed retry to learn its cause.
  // Read only the latest stored outcome's fields, never the potentially large turn body.
  const tail = db.select({ kind: sql<string | null>`json_extract(${sessionTurns.data}, '$.outcome.kind')`,
    message: sql<string | null>`coalesce(json_extract(${sessionTurns.data}, '$.outcome.detail'), json_extract(${sessionTurns.data}, '$.outcome.said'))` })
    .from(sessionTurns).where(eq(sessionTurns.sessionId, sessionId)).orderBy(desc(sessionTurns.seq)).limit(1).get();
  if (tail?.kind !== 'error' || !tail.message) return;
  const row = db.select({ provider: sessions.provider, config: sessions.config }).from(sessions).where(eq(sessions.id, sessionId)).get();
  const model = row?.config?.type === 'acp' ? row.config.model ?? row.config.contextUsage?.modelId ?? undefined : row?.config?.model;
  const key = fingerprint(tail.message, row?.provider ?? undefined, model);
  if (key) write(sessionId, { current: key, acknowledged: [key] });
}

export function clearErrorNotice(sessionId: string): void {
  db.delete(kv).where(eq(kv.key, keyFor(sessionId))).run();
}
