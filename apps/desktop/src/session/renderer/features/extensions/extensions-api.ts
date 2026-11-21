import { rpc, rpcOn } from '@renderer/lib/ipc';
import type { MarketUpdatesSummary, MarketVersionHistoryEntry } from '@shared/extensions/market';
import type { MarketListing } from '@shared/extensions/market-entries';
import type { InstalledExtensionsList } from './installed-extensions';

/** @@@extensions-api-of — host key → its API (#6264); `phone` models read the phone store themselves. */
export const LOCAL_HOST = 'local';
export const PHONE_HOST = 'phone';

/** The models of what a host has installed (its list, its updates, its grants): `refreshTag(INSTALLED, hostKey)` after a change there. */
export const INSTALLED = 'installed';

export const remoteHostKey = (deviceId: string): string => `remote:${deviceId}`;

const remotes = new Map<string, typeof rpc.extensions>();

export function extensionsApiOf(hostKey: string): typeof rpc.extensions {
  if (hostKey === LOCAL_HOST) return rpc.extensions;
  if (!hostKey.startsWith('remote:')) throw new Error(`No extensions API for host ${hostKey}`);
  const deviceId = hostKey.slice('remote:'.length);
  let api = remotes.get(deviceId);
  if (!api) remotes.set(deviceId, (api = rpcOn(deviceId).extensions));
  return api;
}

/** A host's answer, its data or its refusal thrown. */
export function unwrap<T>(result: { success: boolean; data?: T | null; error?: string }, what: string): T {
  if (!result.success || result.data == null) throw new Error(result.error || `${what} unreadable`);
  return result.data;
}

/** What the `phone` host's models read: the phone's own App store (phoneApps.ts) and market page (phoneMarketPage.ts). */
export type PhoneStore = {
  list: () => Promise<InstalledExtensionsList>;
  marketUpdates: () => Promise<MarketUpdatesSummary>;
  marketListing: (args: { extensionId: string; version: string }) => Promise<{ success: true; data: MarketListing } | { success: false; error: string }>;
  marketHistory: (args: { extensionId: string }) => Promise<{ success: boolean; data?: MarketVersionHistoryEntry[]; error?: string }>;
};

const phone: Partial<PhoneStore> = {};

/** Each part registers what it reads as its module loads. */
export function definePhoneStore(part: Partial<PhoneStore>): void {
  Object.assign(phone, part);
}

export function phoneStore<K extends keyof PhoneStore>(name: K): PhoneStore[K] {
  const found = phone[name];
  if (!found) throw new Error('The phone App store is not loaded');
  return found as PhoneStore[K];
}
