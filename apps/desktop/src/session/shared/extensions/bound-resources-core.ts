import { assistantPanelCollection, type AssistantPanelDomain, type AssistantPanelItem, type AssistantPanelSnapshot } from '@gugu/core/cloud/assistantPanel';
import type { ReadableResourceDomain } from './agent-resources';
import type { ReadFailureReason, Unavailable } from './resources-management';

/**
 * #1927 (API 42, reasons 50) The rules an App's window onto the assistant's resources answers by, one copy for both hosts
 * (the desktop's main, electron `app-bound-resources.ts`; the phone's page, `phoneAppBindings.ts`): when a domain can be
 * read, how the store's refusals read to the App, and that changes are refused. Who may ask is each host's; these never decide that.
 */

const denied = (message: string) => Object.assign(new Error(message), { code: 'denied' });
const codeOf = (error: unknown) => (error as { code?: unknown } | null)?.code;
const statusOf = (error: unknown) => (error as { status?: unknown } | null)?.status;

/** A read that could not be made now, and why (50): the class the assistant's own pages tell the person. */
export const unavailable = (reason: ReadFailureReason): Unavailable => ({ state: 'unavailable', reason });
export const reasonOf = (error: unknown): ReadFailureReason => {
  const given = (error as { reason?: unknown } | null)?.reason;
  return typeof given === 'string' ? given as ReadFailureReason : 'unreadable';
};

/**
 * A refusal of the account, by the store or the token, is a refusal; anything else a read could not make now is
 * `unavailable`, with the class the assistant's pages say it as (assistant-panel-errors.ts): out of time, past the store's
 * answer budget, or not read.
 */
export function refusedOrUnavailable(error: unknown): Unavailable {
  const code = codeOf(error);
  if (code === 'denied' || code === 'invalid') throw error;
  if (code === 'account-changed' || code === 'signed-out' || code === '42501' || statusOf(error) === 401 || statusOf(error) === 403) {
    throw denied('This account may not read this agent\'s resources');
  }
  if (code === 'read-timeout') return unavailable('timed-out');
  if (code === '54000') return unavailable('too-large');
  if (code === 'stale') return unavailable('stale');
  if (code === 'application-failed') return unavailable('not-applied');
  return unavailable(code === 'failed' ? reasonOf(error) : 'unreadable');
}

/**
 * Whether `domain` can be read now, exactly as the assistant's own pages decide it (assistantPanelFiles `collection`, which
 * their lists and reads go through, and whose error the page shows instead of the domain): a change in it that failed to
 * apply, or an out-of-date observation, makes the whole domain unreadable — not just that one resource; so does a failed
 * publication. No marker is not yet published, never an empty domain (a voice-note list published in part excepted).
 */
export function domainState(snapshot: AssistantPanelSnapshot, domain: ReadableResourceDomain): Unavailable | { state: 'unprepared' } | { state: 'ready'; items: AssistantPanelItem[] } {
  const collection = assistantPanelCollection(snapshot, domain as AssistantPanelDomain);
  // In the order the pages check them (`collection`): a change that failed to apply, an observation out of date, then
  // a publication that failed.
  if (snapshot.application.some((row) => row.domain === domain && row.status === 'failed')) return unavailable('not-applied');
  if (collection.items.some((item) => item.stale_at)) return unavailable('stale');
  if (collection.state === 'error') return unavailable('unreadable');
  if (collection.state === 'unprepared' && !(domain === 'voice-notes' && collection.items.length > 0)) return { state: 'unprepared' };
  return { state: 'ready', items: collection.items };
}

/**
 * Changes an App asks of the assistant's panel store (saving, removing or managing resources; a schedule change
 * for an assistant that lives elsewhere). Nothing applies those changes on the assistant's computer any more, so both
 * hosts refuse them instead of storing a change that would never take effect. Reads are unchanged.
 */
export function panelChangeRefused(): never {
  throw denied('The personal assistant no longer takes changes to its resources or schedules from Apps');
}
