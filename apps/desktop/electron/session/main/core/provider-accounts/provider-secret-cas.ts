import { and, eq } from 'drizzle-orm';
import type { AppDb, DrizzleTx } from '@main/db/client';
import { providerAccounts } from '@main/db/schema';
import type { ProviderAccountSecretStore } from './provider-account-registry';

/** Sources whose credential the platform keeps: there is no local secret to replace. */
const KEPT_ON_PLATFORM = ['platform', 'platform-rejected-key'];

/** Every credential write advances the row, even twice within one millisecond, so
 * an authorization that stores identical bytes is still a new generation. */
export const nextProviderAccountUpdate = (previous: number, now = Date.now()): number => Math.max(now, previous + 1);

/** One read of an account's secret together with the generation it belongs to:
 * the row, its credential source, its last write and the sealed bytes. */
export function readProviderSecretGeneration(db: AppDb | DrizzleTx, store: ProviderAccountSecretStore,
  providerId: string, accountId: string): { secret: string; generation: string } | null {
  if (!store.atomicSecretSnapshot) throw new Error('This secret store cannot read a credential generation');
  const row = db.select().from(providerAccounts)
    .where(and(eq(providerAccounts.providerId, providerId), eq(providerAccounts.accountId, accountId))).get();
  if (!row || KEPT_ON_PLATFORM.includes(row.meta?.credentialSource ?? '')) return null;
  const snapshot = store.atomicSecretSnapshot(db, row.credentialRef);
  if (!snapshot) return null;
  return { secret: snapshot.secret, generation: JSON.stringify([row.id, row.credentialRef, row.updatedAt, row.meta?.credentialSource ?? null, snapshot.sealed]) };
}

/** A delayed refresh or check may only replace the generation it read before going
 * to the network. The generation is re-read in the same transaction as the write, so
 * a disconnect or a newer authorization in between wins and nothing is written. */
export async function compareAndSwapProviderSecret(db: AppDb, store: ProviderAccountSecretStore,
  providerId: string, accountId: string, generation: string, replacement: string): Promise<boolean> {
  if (!store.atomicSecretCompareAndSwap || !store.atomicSecretSnapshot) throw new Error('This secret store cannot replace a credential conditionally');
  let expected: unknown[];
  try { expected = JSON.parse(generation) as unknown[]; } catch { return false; }
  if (!Array.isArray(expected) || typeof expected[0] !== 'string' || typeof expected[1] !== 'string' || typeof expected[4] !== 'string') return false;
  const write = await store.atomicSecretCompareAndSwap(db, expected[1], expected[4], replacement);
  return db.transaction((tx) => {
    if (readProviderSecretGeneration(tx, store, providerId, accountId)?.generation !== generation) return false;
    if (!write(tx)) return false;
    tx.update(providerAccounts).set({ updatedAt: nextProviderAccountUpdate(Number(expected[2])) })
      .where(eq(providerAccounts.id, expected[0] as string)).run();
    return true;
  });
}
