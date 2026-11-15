import type { MessageItem } from '@gugu/core/shared/types/chat';
import { replica } from '@/lib/replica';
import type { LegacyDm, LegacyDmScope } from './data';

export type LegacyDmListValue = { scope: LegacyDmScope | null; rows: LegacyDm[]; after: string | null };
export type LegacyDmMessagesValue = { rows: MessageItem[]; beforeSeq: number | null };

const data = () => import('./data');

/**
 * The legacy DM archive (the account's whole archive, or one session's own agent's): its first page, and the pages the
 * reader asked for appended (`at(...).set`). The archive is frozen, so the entry is **never refreshed**: `fresh: Infinity`
 * and no refresh source anywhere (a refresh would drop the appended pages). Only a failed first read is read again. A
 * session with no verifiable identity has no history: `{ scope: null }`, a value.
 */
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

/** One legacy DM's latest page, older pages prepended as the reader asks. Frozen like the list: never refreshed. */
export const legacyDmMessages = replica({
  name: 'legacyDmMessages',
  scope: 'account',
  read: async (owner: string, agentUserId: string | null, chatId: string): Promise<LegacyDmMessagesValue> => {
    const { readLegacyDmMessages } = await data();
    return readLegacyDmMessages({ ownerUserId: owner, ...(agentUserId ? { agentUserId } : {}) }, chatId);
  },
  fresh: Infinity,
  keep: 5 * 60_000,
});

/** Whether a session has old chats to offer in its menu: read when the menu was first opened, again after five minutes. */
export const legacyDmHistoryAvailable = replica({
  name: 'legacyDmHistoryAvailable',
  scope: 'account',
  read: async (owner: string, sessionId: string): Promise<boolean> => (await data()).hasLegacyDmHistory(owner, sessionId),
  fresh: 5 * 60_000,
});
