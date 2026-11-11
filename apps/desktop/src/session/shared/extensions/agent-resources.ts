import { z } from 'zod';
import type { Unavailable } from './resources-management';

/**
 * #1927 (API 42): what an App may reach of an agent's durable panel resources through its one conversation binding — the
 * person's private conversation with their personal assistant. The resource store is the assistant panel's (domains with
 * revisions, tombstones, operation ids and apply receipts); this is only the App's window onto it: which domains a
 * manifest may name, the arguments a call may carry, and the shapes it hears back. Who the owner, agent and chat are is
 * the host's, from the signed-in account and the binding — never an argument.
 */

/** The binding actions: `resources` reads (`chat:resources`), `resources:write` changes (`chat:resources:write`). */
export const RESOURCE_BINDING_ACTIONS = ['resources', 'resources:write'] as const;
export type ResourceBindingAction = (typeof RESOURCE_BINDING_ACTIONS)[number];
export const RESOURCE_ACTIONS_API_VERSION = 42;

/**
 * Domains an App may read: what the assistant's own pages show for memory (and the health page built on it), files,
 * personality and profile, skills, and voice-note lists. None is device-scoped.
 */
export const READABLE_RESOURCE_DOMAINS = ['memory', 'files', 'personality', 'skills', 'voice-notes'] as const;
/** Domains an App may change: the same but voice notes, which only the recorder and transcription write. */
export const WRITABLE_RESOURCE_DOMAINS = ['memory', 'files', 'personality', 'skills'] as const;
/**
 * Never grantable: connections and their credentials (`integrations`), the store's own `control` row, and the domains that
 * are device-scoped or work state (`tasks`, `schedules`, `capabilities`, `device-notes`), which this binding does not
 * carry.
 */
export const UNGRANTABLE_RESOURCE_DOMAINS = ['integrations', 'control', 'tasks', 'schedules', 'capabilities', 'device-notes'] as const;
export type ReadableResourceDomain = (typeof READABLE_RESOURCE_DOMAINS)[number];

/** Why a manifest may not name `domain` for `action`; null: it may. */
export function resourceDomainProblem(action: ResourceBindingAction, domain: string): string | null {
  const allowed: readonly string[] = action === 'resources' ? READABLE_RESOURCE_DOMAINS : WRITABLE_RESOURCE_DOMAINS;
  if (allowed.includes(domain)) return null;
  if ((UNGRANTABLE_RESOURCE_DOMAINS as readonly string[]).includes(domain)) return `the "${domain}" resource domain is never granted to an App`;
  if ((READABLE_RESOURCE_DOMAINS as readonly string[]).includes(domain)) return `the "${domain}" resource domain is read only`;
  return `"${domain}" is not a resource domain (${allowed.join(', ')})`;
}

/** A resource as an App sees it: its key, version and metadata — never the owner, agent, device or the body's file. */
export type AppResource = { key: string; revision: string; updatedAt: string; data: Record<string, unknown> };
type Named = { name: string; domain: string };
/**
 * `gugu.bindings.resources(name, domain)`: one domain, whole. `unprepared`: the agent has not published it yet;
 * `unavailable`: it cannot be read now, and (50) why, from a closed list (`ReadFailureReason`). Never an empty list for
 * either.
 */
export type AppResourceList = Named & ({ state: 'unbound' | 'unprepared' } | Unavailable | { state: 'ready'; revision: string; resources: AppResource[] });
/**
 * `gugu.bindings.resource(name, domain, key)`: one resource and its content. `missing`: no such key (`revision` "0", what
 * creating it expects) or a deleted one (`deleted`, its tombstone's revision); `unprepared`: there, its content not stored yet.
 */
export type AppResourceRead = Named & { key: string } & (
  | { state: 'unbound' | 'unprepared' }
  | Unavailable
  | { state: 'missing'; revision: string; deleted?: true }
  | { state: 'ready'; resource: AppResource; content: string; truncated: boolean; totalSize: number; binary?: true }
);
/** The store's apply receipt: `pending` until the agent's machine applied it, then `applied` or `failed`; `superseded` by a later change. */
export type AppResourceReceipt = { operationId: string; revision: string; status: 'pending' | 'failed' | 'applied' | 'superseded'; terminal?: boolean };
/**
 * `gugu.bindings.save` / `remove`. `conflict`: `expectedRevision` is not the resource's revision now — read it again.
 * `deleted`: the resource was deleted and this domain cannot bring it back. `unavailable`: the store could not be reached;
 * whether the change landed is unknown, and the same call (same `operationId`) answers it.
 */
export type AppResourceWrite = Named & { key: string } & (
  | { state: 'unbound' | 'conflict' | 'deleted' }
  | Unavailable
  | { state: 'committed'; receipt: AppResourceReceipt }
);
/** What `gugu.bindings.onResourcesChanged(name, fn)` hears: something changed (read again), or the subscription ended. */
export type AppResourceEvent = { name: string; state: 'changed' | 'ended' };

/** Metadata fields an App sees of each domain: the store's own allow-list for it, nothing else. */
const DATA_FIELDS: Record<ReadableResourceDomain, readonly string[]> = {
  memory: ['title', 'path', 'relativePath', 'createdAt', 'modifiedAt', 'kind'],
  files: ['name', 'path', 'parentKey', 'kind', 'contentType', 'sizeBytes', 'modifiedAt'],
  personality: ['preset', 'text'],
  skills: ['name', 'description', 'modifiedAt'],
  'voice-notes': ['noteId', 'kind', 'title', 'createdAt', 'updatedAt', 'status', 'phase', 'durationMs', 'startMs', 'voicedMs', 'failureCode'],
};
export function appResourceOf(domain: ReadableResourceDomain, item: { resource_key: string; revision: string; updated_at: string; data: Record<string, unknown> }): AppResource {
  const data = Object.fromEntries(DATA_FIELDS[domain].filter((field) => Object.hasOwn(item.data, field)).map((field) => [field, item.data[field]]));
  return { key: item.resource_key, revision: item.revision, updatedAt: item.updated_at, data };
}

const invalid = (message: string): never => {
  throw Object.assign(new Error(message), { code: 'invalid' as const });
};

/** A domain named by a call: one of the store's, or `invalid` (whether this App declared it is the host's to say). */
export function resourceDomainOf(value: unknown): string {
  const known: readonly string[] = [...READABLE_RESOURCE_DOMAINS, ...UNGRANTABLE_RESOURCE_DOMAINS];
  return typeof value === 'string' && known.includes(value) ? value : invalid(`domain is one of ${READABLE_RESOURCE_DOMAINS.join(', ')}`);
}

/**
 * A resource key, as the store and the assistant's pages keep it: a relative path (`notes/today.md`), a skill's name, or
 * `instructions` for personality. No absolute path, `.`/`..`, backslash, colon, percent escape, control character or
 * collection marker. `forWrite`: a skill is one name, and personality has one key.
 */
export function resourceKeyOf(domain: string, value: unknown, forWrite = false): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) return invalid('key is a resource key, 1 to 512 characters');
  if (value.startsWith('__collection__')) return invalid('key names a resource, not a collection');
  const control = [...value].some((char) => char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f);
  if (control || /(^[/~]|[\\:%]|(^|\/)\.{1,2}(\/|$)|\/\/|\/$)/.test(value) || value.split('/').some((part) => part !== part.trim() || part === '')) {
    return invalid('key is a relative path of names separated by "/"');
  }
  if (domain === 'personality' && value !== 'instructions') return invalid('personality has one resource, "instructions"');
  if (forWrite && domain === 'skills' && value.includes('/')) return invalid('a skill is saved by its name, without "/"');
  return value;
}

/** Arguments of a change: the caller's own idempotency id and the revision it read; a replay of the same id is the same change. */
export const resourceChangeSchema = z.strictObject({
  domain: z.unknown(),
  key: z.unknown(),
  operationId: z.string().uuid(),
  expectedRevision: z.string().regex(/^\d{1,19}$/),
  content: z.string().optional(),
});
