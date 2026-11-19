import { replica } from '@/lib/replica';
import type { LegacyDm, LegacyDmScope } from './data';

type LegacyDmListValue = { scope: LegacyDmScope | null; rows: LegacyDm[]; after: string | null };

const data = () => import('./data');

/** The legacy DM archive: first page plus pages appended by `at(...).set`. Frozen, so **never refreshed** (it drops them). */
export const legacyDmList = replica({
  name: 'legacyDmList',
  scope: 'account',
  read: async (owner: string, sessionId: string | null, search: string): Promise<LegacyDmListValue> => {
    const { readLegacyDmList, readSessionLegacyScope } = await data();
    const scope = sessionId ? await readSessionLegacyScope(owner, sessionId) : { ownerUserId: owner };
    if (!scope) return { scope: null, rows: [], after: null };
    const page = await readLegacyDmList(scope, undefined, search);
    return { scope, rows: page.rows, after: page.after };
  },
  fresh: Infinity,
  keep: 5 * 60_000,
});

/** One legacy DM's latest page, older pages prepended as asked. Frozen: never refreshed. */
export const legacyDmMessages = replica({
  name: 'legacyDmMessages',
  scope: 'account',
  read: async (owner: string, agentUserId: string | null, chatId: string) => {
    const { readLegacyDmMessages } = await data();
    return readLegacyDmMessages({ ownerUserId: owner, ...(agentUserId ? { agentUserId } : {}) }, chatId);
  },
  fresh: Infinity,
  keep: 5 * 60_000,
});

/** Whether a session has old chats to offer in its menu (read on first open, again after five minutes). */
export const legacyDmHistoryAvailable = replica({
  name: 'legacyDmHistoryAvailable',
  scope: 'account',
  read: async (owner: string, sessionId: string): Promise<boolean> => (await data()).hasLegacyDmHistory(owner, sessionId),
  fresh: 5 * 60_000,
});
