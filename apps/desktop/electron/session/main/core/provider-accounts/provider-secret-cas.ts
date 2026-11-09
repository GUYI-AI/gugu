import {and,eq} from 'drizzle-orm';
import type {AppDb,DrizzleTx} from '@main/db/client';
import {providerAccounts} from '@main/db/schema';
import type {ProviderAccountSecretStore} from './provider-account-registry';
import {isManagedConnectionRevoked,managedConnectionBinding} from './connection-effect-evidence';

const KEPT_ON_PLATFORM=['platform','platform-rejected-key'];
/** Every credential write advances the row, even twice within one millisecond. */
export const nextProviderAccountUpdate=(previous:number,now=Date.now()):number=>Math.max(now,previous+1);

/** One read of an account's secret together with the generation it belongs to:
 * the row, its credential source, the sealed bytes and the explicit
 * authorization binding. A revoked (fenced) account has no usable generation. */
export function readProviderSecretGeneration(db:AppDb|DrizzleTx,store:ProviderAccountSecretStore,providerId:string,accountId:string):{secret:string;generation:string}|null {
  if(!store.atomicSecretSnapshot)throw Error('CONNECTION_ATOMIC_STORE_UNAVAILABLE');
  const row=db.select().from(providerAccounts).where(and(eq(providerAccounts.providerId,providerId),eq(providerAccounts.accountId,accountId))).get();
  if(!row||KEPT_ON_PLATFORM.includes(row.meta?.credentialSource??'')||isManagedConnectionRevoked(db,providerId,accountId))return null;
  const snapshot=store.atomicSecretSnapshot(db,row.credentialRef);
  if(!snapshot)return null;
  return {secret:snapshot.secret,generation:JSON.stringify([row.id,row.credentialRef,row.updatedAt,row.meta?.credentialSource??null,
    snapshot.sealed,managedConnectionBinding(db,providerId,accountId)])};
}

/** A delayed refresh can only replace the generation it read before refreshing.
 * The generation and the revocation fence are checked in the same transaction
 * as the write, so a refresh cannot survive a remove that retains the secret
 * nor replace a newer authorization, even one with identical plaintext. */
export async function compareAndSwapProviderSecret(db:AppDb,store:ProviderAccountSecretStore,
  providerId:string,accountId:string,generation:string,replacement:string):Promise<boolean> {
  if(!store.atomicSecretCompareAndSwap||!store.atomicSecretSnapshot)throw Error('CONNECTION_ATOMIC_STORE_UNAVAILABLE');
  let expected:unknown[];
  try{expected=JSON.parse(generation) as unknown[];}catch{return false;}
  if(!Array.isArray(expected)||typeof expected[1]!=='string'||typeof expected[4]!=='string')return false;
  const write=await store.atomicSecretCompareAndSwap(db,expected[1],expected[4],replacement);
  if(!write)return false;
  return db.transaction(tx=>{
    if(readProviderSecretGeneration(tx,store,providerId,accountId)?.generation!==generation)return false;
    if(!write(tx))return false;
    tx.update(providerAccounts).set({updatedAt:nextProviderAccountUpdate(Number(expected[2]))}).where(eq(providerAccounts.id,String(expected[0]))).run();
    return true;
  });
}
