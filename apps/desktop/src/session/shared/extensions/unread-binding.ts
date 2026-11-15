import { z } from 'zod';
import type { AppFileEntry } from './app-runtime-protocol';
import { ASSISTANT_BINDING_ACTIONS, ASSISTANT_BINDING_API_VERSION } from './assistant-binding';
import { RESOURCE_ACTIONS_API_VERSION, RESOURCE_BINDING_ACTIONS } from './agent-resources';
import { RESOURCES_MANAGEMENT_API_VERSION, VOICE_NOTES_MANAGE_ACTION } from './resources-management';
import { VOICE_NOTE_API_VERSION, VOICE_NOTE_RECORD_ACTION } from './voice-note-session';

/**
 * What one conversation binding may do (#1927). `unread` is the binding itself: it is what the person chose the
 * conversation for. `files` (API 40): list and read that conversation's chat-folder files, read only. `draft` (API 40):
 * put words into that conversation's composer; the person sends them, or not. Each extra action is its own capability,
 * consented and withdrawn on its own (`BINDING_ACTION_CAPABILITY`), from the API version it came in
 * (`BINDING_ACTION_API_VERSION`). `surface` (API 41, #1925): the App's main page is shown beside that conversation, which
 * the host draws natively (`contributes.conversationSurface`); the App learns only whether it is shown and whether its panel
 * is collapsed. `resources` / `resources:write` (API 42, #1927, agent-resources.ts): read / change the panel resources of the
 * agent whose private conversation with the person this is, in the domains the binding lists for each. `assistant-status` /
 * `assistant-open` (#1925, API 44): the conversation's assistant, when it is the person's own (assistant-binding.ts).
 * `work` (#1925, API 46, work-binding.ts): when that conversation is the person's private chat with their own assistant,
 * the list of work the assistant handed out, and one task's conversation drawn by the host in the App's panel.
 * `voice-notes:record` (#1927, API 47, voice-note-session.ts): drive the host's voice-note recorder for that same assistant.
 * `voice-notes:manage` (API 50, resources-management.ts): its agent's voice notes transcribed, removed or exported.
 */
// #1928 (API 43, bound-schedules.ts): `schedules` / `schedules:control`, the schedules of the agent the conversation is with.
export const CONVERSATION_BINDING_ACTIONS = ['unread', 'files', 'draft', 'surface', ...RESOURCE_BINDING_ACTIONS, 'schedules', 'schedules:control', ...ASSISTANT_BINDING_ACTIONS, 'work', VOICE_NOTE_RECORD_ACTION, VOICE_NOTES_MANAGE_ACTION] as const;
export type ConversationBindingAction = (typeof CONVERSATION_BINDING_ACTIONS)[number];
export const BINDING_ACTION_CAPABILITY = {
  unread: 'chat:unread', files: 'chat:files', draft: 'chat:draft', surface: 'chat:surface',
  resources: 'chat:resources', 'resources:write': 'chat:resources:write',
  schedules: 'chat:schedules', 'schedules:control': 'chat:schedules:control',
  'assistant-status': 'assistant:status', 'assistant-open': 'assistant:open', 'assistant-rename': 'assistant:rename',
  'voice-notes:manage': 'chat:voice-notes:manage',
  work: 'chat:work',
  [VOICE_NOTE_RECORD_ACTION]: 'chat:voice-notes:record',
} as const;
/** The first App API that lets a binding declare more than `unread`. */
export const BINDING_ACTIONS_API_VERSION = 40;
/** The first App API of each action beyond `unread` (40 files and draft, 41 surface, 42 resources, 43 schedules, 44 the assistant's, 46 work, 47 its voice-note recorder). */
export const BINDING_ACTION_API_VERSION = {
  files: BINDING_ACTIONS_API_VERSION, draft: BINDING_ACTIONS_API_VERSION,
  surface: 41,
  resources: RESOURCE_ACTIONS_API_VERSION, 'resources:write': RESOURCE_ACTIONS_API_VERSION,
  // bound-schedules.ts's BOUND_SCHEDULES_API_VERSION (it imports BINDING_NAME from here, so not imported back).
  schedules: 43, 'schedules:control': 43,
  'assistant-status': ASSISTANT_BINDING_API_VERSION, 'assistant-open': ASSISTANT_BINDING_API_VERSION, 'assistant-rename': ASSISTANT_BINDING_API_VERSION,
  'voice-notes:manage': RESOURCES_MANAGEMENT_API_VERSION,
  work: 46,
  [VOICE_NOTE_RECORD_ACTION]: VOICE_NOTE_API_VERSION,
} as const satisfies Record<Exclude<ConversationBindingAction, 'unread'>, number>;
export const BINDING_NAME = /^[a-z][a-z0-9-]{0,47}$/;

/**
 * Where the main page goes beside the bound conversation (#1925). One layout only: the conversation is the main column and
 * the page is the collapsible panel on its right, the frame the built-in assistant page draws.
 */
export const CONVERSATION_SURFACE_PLACEMENTS = ['side-panel'] as const;

/**
 * #1925 (API 46) The top row the host draws above the conversation column (`contributes.conversationSurface.header`).
 * `assistant`: the built-in assistant page's own row — the assistant's face and name (a click: the App hears
 * `intent: { kind: "profile" }`), search, its settings gear (the host's settings page over the App's panel), expand. Drawn
 * only while the bound conversation is the person's private chat with their own assistant, from the host's own data.
 */
export const CONVERSATION_SURFACE_HEADERS = ['assistant'] as const;
export type ConversationSurfaceHeader = (typeof CONVERSATION_SURFACE_HEADERS)[number];
export const CONVERSATION_SURFACE_HEADER_API_VERSION = 46;

/**
 * The top-right corner of the App's page that the host's 收起面板 control covers while the panel is open (#1925): `right`
 * px in from the page's right edge, `top` px down from its top, the control centred in that band — the built-in assistant
 * panel's top row (52px high, its control 16px in from the edge). The same at every panel width. A page drawing its own top
 * row (its name, its tabs) lines up with the built-in by making that row `top` px high and keeping `right` px clear.
 */
export const CONVERSATION_SURFACE_PANEL_INSET: Readonly<{ top: number; right: number }> = Object.freeze({ top: 52, right: 48 });

/**
 * What the person asked of the App's page through the host, told once in the `onSurface` event that follows the click and
 * never in an answer. From the host's own row (46, `contributes.conversationSurface.header`): `profile` = the assistant's
 * face and name were clicked, show its profile. #1927 (48): `composer-action` = the person clicked the App's composer entry
 * `id` (its own manifest's id, whose run is `{ kind: "page-intent" }`: composer-actions.ts); `voice-note` = the person opened
 * the note the host's recording bar shows; `customize` = the person opened the host's 「自定义<name>」 hint above the composer of
 * the account's own assistant chat (46 `header: "assistant"` only; offered once after the assistant is set up): open what
 * customizes the assistant (name, look, character). The panel is expanded (and any host page over it closed) before it is told. Nothing else
 * comes with it. `APP_SURFACE_INTENTS`: the ones the window may report from its own row.
 *
 * Entry switch, the product's own trusted assistant App only: `resume` = the tab the person last had open on the built-in
 * assistant page this App replaces (`ASSISTANT_RESUME_TABS`; 动态 is the default and never told). Handed over once per
 * account on this computer, when the App first becomes where the assistant entry goes; told once, in the first `bound`
 * answer to `surface(name)` or `onSurface` event that follows (whichever comes first), then gone. Open that tab first.
 */
export const ASSISTANT_RESUME_TABS = ['tasks', 'memory', 'profile'] as const;
export type AssistantResumeTab = (typeof ASSISTANT_RESUME_TABS)[number];
export type AppSurfaceIntent = { kind: 'profile' } | { kind: 'voice-note' } | { kind: 'composer-action'; id: string }
  | { kind: 'customize' } | { kind: 'resume'; tab: AssistantResumeTab };
export const APP_SURFACE_INTENTS = ['profile'] as const;

/**
 * `gugu.bindings.surface(name)` (41, `chat:surface`): whether the bound conversation is drawn beside this page now, and in
 * which layout (49): `side-panel` on a computer — whether this page's panel is collapsed, and the corner of the page the
 * host's control covers (`panel.inset`); `phone` on a phone — the conversation is the layer's first section, the host's, and
 * this page fills the section the person is on (`section`, phone-binding.ts), full screen, with no tab row of its own.
 * `unbound` says only that it is not: no chosen conversation, the grant withdrawn, the account switched or out of it, or
 * the page shown elsewhere. Never the chat, its messages or its people. 46: `hostPage` (`panel.hostPage` on a computer) — a
 * page of the host's own is drawn over the App's page now (a task's conversation, the assistant's settings), never which or
 * what it shows; `intent`, in an `onSurface` event only (`AppSurfaceIntent`).
 */
export type AppBindingSurface = { name: string; state: 'unbound' }
  | { name: string; state: 'bound'; layout: 'side-panel'; panel: { collapsed: boolean; inset: { top: number; right: number }; hostPage: boolean }; intent?: AppSurfaceIntent }
  | { name: string; state: 'bound'; layout: 'phone'; section: import('./phone-binding').PhoneSurfaceSection; hostPage: boolean; intent?: AppSurfaceIntent };

/** A stored target is host data and never part of the App's answer. */
export const storedUnreadBindingSchema = z.strictObject({
  ownerId: z.string().uuid(),
  name: z.string().regex(BINDING_NAME),
  chatId: z.string().uuid(),
  handle: z.string().uuid(),
});
export type StoredUnreadBinding = z.infer<typeof storedUnreadBindingSchema>;
/**
 * #1925 A binding the trusted window may draw beside the App's page, with `authority`: host data that stays the same while
 * this App's installation, switch, grants, selection and the account do, and is new once any of them changed.
 */
export type GrantedSurfaceBinding = StoredUnreadBinding & {
  authority: string;
  /** 46: the row to draw above the conversation; null unless declared and the conversation is the account's own assistant chat. */
  header: ConversationSurfaceHeader | null;
};
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
