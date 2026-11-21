import { replica } from '@/lib/replica';
import type { LegacyDm, LegacyDmScope } from './data';

type LegacyDmListValue = { scope: LegacyDmScope | null; rows: LegacyDm[]; after: string | null };

const data = () => import('./data');

/**
 * The legacy DM archive a page at a time (`after`: the last id of the page before; null = the first). Frozen, so
 * **never refreshed**. A page of a session's history asks again which archive the session reads (a local lookup).
 */
export const legacyDmList = replica({
  name: 'legacyDmList',
  scope: 'account',
  read: async (owner: string, sessionId: string | null, search: string, after: string | null): Promise<LegacyDmListValue> => {
    const { readLegacyDmList, readSessionLegacyScope } = await data();
    const scope = sessionId ? await readSessionLegacyScope(owner, sessionId) : { ownerUserId: owner };
    if (!scope) return { scope: null, rows: [], after: null };
    const page = await readLegacyDmList(scope, after ?? undefined, search);
    return { scope, rows: page.rows, after: page.after };
  },
  fresh: Infinity,
  keep: 5 * 60_000,
});

/** One legacy DM a page at a time, newest first (`before`: the seq older pages end at; null = the latest). Frozen: never refreshed. */
export const legacyDmMessages = replica({
  name: 'legacyDmMessages',
  scope: 'account',
  read: async (owner: string, agentUserId: string | null, chatId: string, before: string | null) => {
    const { readLegacyDmMessages } = await data();
    return readLegacyDmMessages({ ownerUserId: owner, ...(agentUserId ? { agentUserId } : {}) }, chatId, before === null ? undefined : Number(before));
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
