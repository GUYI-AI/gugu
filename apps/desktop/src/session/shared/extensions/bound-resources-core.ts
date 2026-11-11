import { assistantPanelCollection, type AssistantPanelDomain, type AssistantPanelItem, type AssistantPanelSnapshot } from '@gugu/core/cloud/assistantPanel';
import { parseMemoryNote } from '@gugu/core/shared/assistantMemory';
import type { ReadableResourceDomain } from './agent-resources';

/**
 * #1927 (API 42) The rules an App's window onto the assistant's resources answers by, one copy for both hosts (the desktop's
 * main, electron `app-bound-resources.ts`; the phone's page, `phoneAppBindings.ts`): when a domain can be read, what a save
 * stores, and how the store's refusals read to the App. Who may ask is each host's; these never decide that.
 */

const coded = (code: 'denied' | 'invalid', message: string) => Object.assign(new Error(message), { code });
const codeOf = (error: unknown) => (error as { code?: unknown } | null)?.code;
const statusOf = (error: unknown) => (error as { status?: unknown } | null)?.status;

/**
 * Whether `domain` can be read now, exactly as the assistant's own pages decide it (assistantPanelFiles `collection`, which
 * their lists and reads go through, and whose error the page shows instead of the domain): a change in it that failed to
 * apply, or an out-of-date observation, makes the whole domain unreadable — not just that one resource; so does a failed
 * publication. No marker is not yet published, never an empty domain (a voice-note list published in part excepted).
 */
export function domainState(snapshot: AssistantPanelSnapshot, domain: ReadableResourceDomain): { state: 'unavailable' | 'unprepared' } | { state: 'ready'; items: AssistantPanelItem[] } {
  const collection = assistantPanelCollection(snapshot, domain as AssistantPanelDomain);
  if (snapshot.application.some((row) => row.domain === domain && row.status === 'failed')) return { state: 'unavailable' };
  if (collection.state === 'error' || collection.items.some((item) => item.stale_at)) return { state: 'unavailable' };
  if (collection.state === 'unprepared' && !(domain === 'voice-notes' && collection.items.length > 0)) return { state: 'unprepared' };
  return { state: 'ready', items: collection.items };
}

/**
 * What a save stores of `domain`, as the assistant's own pages store it for a text written there (assistantPanelFiles
 * `write`, `writeText`'s `text/plain`): the same fields, so the assistant's pages and the agent read an App's change as
 * their own. A resource keeps its path; a new one's path is its key.
 */
export function savedData(domain: 'memory' | 'files' | 'skills', key: string, existing: AssistantPanelItem | null, text: string, modifiedAt: string): Record<string, unknown> {
  const live = existing && !existing.deleted_at ? existing : null;
  if (domain === 'memory') {
    const relative = typeof live?.data.relativePath === 'string' ? live.data.relativePath : key;
    const note = parseMemoryNote(relative.split('/').pop()!, text);
    return { relativePath: relative, title: note.title, modifiedAt, kind: relative === 'owner-profile.md' ? 'user' : note.kind };
  }
  if (domain === 'files') {
    const path = typeof live?.data.path === 'string' ? live.data.path : key;
    return { name: path.split('/').pop()!, path, kind: 'file', contentType: 'text/plain', sizeBytes: new TextEncoder().encode(text).byteLength, modifiedAt };
  }
  return { name: key, modifiedAt };
}

/** A refusal of the account, by the store or the token, is a refusal; anything else a read could not make now is `unavailable`. */
export function refusedOrUnavailable(error: unknown): 'unavailable' {
  const code = codeOf(error);
  if (code === 'denied' || code === 'invalid') throw error;
  if (code === 'account-changed' || code === 'signed-out' || code === '42501' || statusOf(error) === 401 || statusOf(error) === 403) {
    throw coded('denied', 'This account may not read this agent\'s resources');
  }
  return 'unavailable';
}

/** A change the store refused, said as the App hears it; a refusal of the request itself is thrown. */
export function writeOutcome(error: unknown): 'conflict' | 'deleted' | 'unavailable' {
  const code = codeOf(error);
  if (code === 'PT409' || code === '40001') return 'conflict';
  if (code === '55000') return 'deleted';
  if (code === '23505') throw coded('invalid', 'This operationId was already used for a different change');
  if (code === '22023' || code === '54000') throw coded('invalid', 'The resource store does not take this change as it is');
  return refusedOrUnavailable(error);
}
