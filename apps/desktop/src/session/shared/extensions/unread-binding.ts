import { z } from 'zod';
import type { AppFileEntry } from './app-runtime-protocol';

/**
 * What one conversation binding may do (#1927). `unread` is the binding itself: it is what the person chose the
 * conversation for. `files` (API 40): list and read that conversation's chat-folder files, read only. `draft` (API 40):
 * put words into that conversation's composer; the person sends them, or not. Each extra action is its own capability,
 * consented and withdrawn on its own (`BINDING_ACTION_CAPABILITY`).
 * `resources` / `resources:write` (API 42, agent-resources.ts): read / change the panel resources of the agent whose
 * private conversation with the person this is, in the domains the binding lists for each.
 * `voice-notes:record` (API 47, voice-note-session.ts): drive the host's voice-note recorder for that same assistant.
 */
export const CONVERSATION_BINDING_ACTIONS = ['unread', 'files', 'draft', 'resources', 'resources:write', 'voice-notes:record'] as const;
export type ConversationBindingAction = (typeof CONVERSATION_BINDING_ACTIONS)[number];
export const BINDING_ACTION_CAPABILITY = {
  unread: 'chat:unread', files: 'chat:files', draft: 'chat:draft',
  resources: 'chat:resources', 'resources:write': 'chat:resources:write',
  'voice-notes:record': 'chat:voice-notes:record',
} as const;
/** The first App API that lets a binding declare more than `unread`. */
export const BINDING_ACTIONS_API_VERSION = 40;
export const BINDING_NAME = /^[a-z][a-z0-9-]{0,47}$/;

/** A stored target is host data and never part of the App's answer. */
export const storedUnreadBindingSchema = z.strictObject({
  ownerId: z.string().uuid(),
  name: z.string().regex(BINDING_NAME),
  chatId: z.string().uuid(),
  handle: z.string().uuid(),
});
export type StoredUnreadBinding = z.infer<typeof storedUnreadBindingSchema>;
export type AppUnreadBinding = { name: string; state: 'unbound'; actions: readonly ConversationBindingAction[] }
  | { name: string; state: 'bound'; handle: string; actions: readonly ConversationBindingAction[] };

/**
 * A bound conversation's file as an App sees it: where it is in that folder and what it is — never the chat, an item id,
 * who made or changed it, the messages it came from or another App's metadata.
 */
export type AppBoundEntry = Pick<AppFileEntry, 'name' | 'path' | 'type' | 'contentType' | 'size' | 'version' | 'createdAt' | 'updatedAt'>;
export function boundEntryOf(entry: AppFileEntry): AppBoundEntry {
  const { name, path, type, contentType, size, version, createdAt, updatedAt } = entry;
  return { name, path, type, contentType, size, version, createdAt, updatedAt };
}

/**
 * `gugu.bindings.list` / `read` answers. `missing`: no such file or folder there. `unprepared`: the file is there, its
 * content not yet (no bytes in the store yet). `unavailable`: it cannot be read now (the machine keeping it is off, the
 * file service or database did not answer) — try again later. None of them is an empty list.
 */
export type AppBoundList = { name: string; state: 'unbound' } | { name: string; state: 'missing' } | { name: string; state: 'unavailable' }
  | { name: string; state: 'ready'; entries: AppBoundEntry[] };
export type AppBoundRead = { name: string; state: 'unbound' | 'missing' | 'unprepared' | 'unavailable' }
  | { name: string; state: 'ready'; entry: AppBoundEntry; content: string; truncated: boolean; totalSize: number; binary?: true; exact?: boolean };

const invalid = (message: string): never => {
  throw Object.assign(new Error(message), { code: 'invalid' as const });
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A path inside the bound conversation's folder, from its top (`notes/today.json`). Only names: no absolute path, no `.` or
 * `..`, no backslash, control character or item id. `''` is the top (a folder only). The database resolves it inside the
 * bound chat alone, as the person; this refuses anything that could mean another place before anything is asked.
 */
export function boundPathOf(value: unknown, what: 'path' | 'folder'): string {
  if (typeof value !== 'string') return invalid(`${what} is a path in the bound conversation's folder, a string`);
  if (value.length > 1024) return invalid(`${what} is at most 1024 characters`);
  if (value === '') return what === 'folder' ? '' : invalid('path names a file: it is not empty');
  const control = [...value].some((char) => char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f);
  if (control || value.includes('\\') || value.startsWith('/') || value.endsWith('/')) {
    return invalid(`${what} is relative to the top of the bound conversation's folder, with "/" between names`);
  }
  const parts = value.split('/');
  if (parts.some((part) => part.trim() === '' || part === '.' || part === '..' || part !== part.trim())) {
    return invalid(`${what} has an empty, "." or ".." name in it`);
  }
  if (parts.some((part) => UUID.test(part))) return invalid(`${what} names files by their path, never by an id`);
  return value;
}

export function unreadBindingKey(ownerId: string, appIdentity: string): string {
  return `${z.string().uuid().parse(ownerId)}/${appIdentity}`;
}

export function readUnreadBindings(value: unknown): Record<string, StoredUnreadBinding> {
  const parsed = z.record(z.string(), storedUnreadBindingSchema).parse(value);
  for (const [key, binding] of Object.entries(parsed)) {
    if (!key.startsWith(`${binding.ownerId}/`) || key.split('/').length !== 3) throw new Error('Invalid unread binding identity');
  }
  return Object.assign(Object.create(null) as Record<string, StoredUnreadBinding>, parsed);
}
