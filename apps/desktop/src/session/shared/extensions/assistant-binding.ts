import { z } from 'zod';

/**
 * #1925 (API 44) What an App whose conversation binding (#1927) is the person's private chat with their own assistant may
 * ask of the host about that assistant. Setting it up, moving its home and closing it create identities, take leases, copy
 * credentials and clean up: they stay the host's own screens. The App only
 * - `assistant-status` (`assistant:status`): reads a small snapshot of the assistant (`AppAssistantStatus`) and hears when
 *   it changes;
 * - `assistant-open` (`assistant:open`): in the person's click, asks the host to open one of its existing screens for the
 *   assistant (`ASSISTANT_SCREENS`, nothing else), and moves on the setup steps the App draws itself (connect → ready →
 *   done). The answer is that it was done or refused; nothing of what the person then does there.
 * Each action needs `unread` (the binding itself) and its own capability, consented and withdrawn on its own.
 */
export const ASSISTANT_BINDING_ACTIONS = ['assistant-status', 'assistant-open'] as const;
export type AssistantBindingAction = (typeof ASSISTANT_BINDING_ACTIONS)[number];
export const ASSISTANT_BINDING_API_VERSION = 44;

/**
 * The host screens `gugu.assistant.open` opens, each by its existing entry (`lib/assistantAppHost.ts`): the assistant
 * section of Settings (setup — the onboarding, when there is no assistant — and the move group are both drawn there), the
 * one close confirmation, its look and model tabs, the devices and connected-apps sections. A closed list: no other
 * value, and nothing more than the value, is taken.
 */
export const ASSISTANT_SCREENS = ['setup', 'move', 'close', 'look', 'model', 'devices', 'connected-apps'] as const;
export type AssistantScreen = (typeof ASSISTANT_SCREENS)[number];

/**
 * Where setup is (the built-in view's `AssistantSetupStep`): `shell` the host's part (welcome → name → home), `connect` /
 * `ready` the steps an App draws itself. null: not in setup.
 */
export const ASSISTANT_SETUP_STEPS = ['shell', 'connect', 'ready'] as const;
export type AppAssistantSetupStep = (typeof ASSISTANT_SETUP_STEPS)[number];
/** What `gugu.assistant.advanceSetup` moves to: `ready`, or `done` (out of setup). */
export const ASSISTANT_SETUP_ADVANCES = ['ready', 'done'] as const;
export type AssistantSetupAdvance = (typeof ASSISTANT_SETUP_ADVANCES)[number];

/**
 * The steps an App may move itself, checked the same by main (against the snapshot it holds) and the window (against the
 * step it keeps): from `connect` to `ready` or done, from `ready` to done. Never into or out of `shell`, never back, never
 * from outside setup.
 */
export function setupAdvanceAllowed(from: AppAssistantSetupStep | null, next: AssistantSetupAdvance): boolean {
  return from === 'connect' || (from === 'ready' && next === 'done');
}

/** The cloud failure classes are words (`cloudComputerFailureKind`): never an id, a path or a message. */
const FAILURE_CLASS = /^[a-z][a-z_]{0,39}$/;
/** The assistant's face as the host draws it for an App (`memberFace`): a small image of its own, never a storage URL. */
const FACE = /^data:image\/(?:webp|png);base64,[A-Za-z0-9+/=]+$/;
const FACE_MAX = 512 * 1024;
export const NAME_MAX = 200;
export const isFailureClass = (value: string) => FAILURE_CLASS.test(value);
export const isAssistantFace = (value: string) => value.length <= FACE_MAX && FACE.test(value);

/**
 * The assistant as an App sees it: only what the built-in view's `AssistantShellSnapshot` already holds and an App needs
 * to pick what to draw — no chat, device or account id, no path, no token.
 * - `assistant`: found / loading / none / unreadable (a failed read, never said as none);
 * - `name`, `avatar`: its name and face (`data:` image), null until it is found;
 * - `home`: where it lives (cloud, this computer, another computer, a server) and whether it answers there now (a cloud
 *   home that is resting wakes when spoken to: online); null until known;
 * - `setup`, `preparing`: the setup step (null: not in setup), and whether its home is being made now;
 * - `cloudAvailable`: whether a cloud home can be had; `member`: membership, null when not known (never false for that);
 * - `loadError`: the class of the cloud service's last failed read, null when it did not fail.
 */
export const appAssistantStatusSchema = z.strictObject({
  assistant: z.enum(['found', 'loading', 'none', 'unreadable']),
  name: z.string().max(NAME_MAX).nullable(),
  avatar: z.string().max(FACE_MAX).regex(FACE).nullable(),
  home: z.strictObject({ kind: z.enum(['cloud', 'this-computer', 'other-computer', 'server']), online: z.boolean() }).nullable(),
  setup: z.enum(ASSISTANT_SETUP_STEPS).nullable(),
  preparing: z.boolean(),
  cloudAvailable: z.boolean(),
  member: z.boolean().nullable(),
  loadError: z.string().regex(FAILURE_CLASS).nullable(),
});
export type AppAssistantStatus = z.infer<typeof appAssistantStatusSchema>;

/**
 * `gugu.assistant.status(name)`. `ready`: the bound assistant's snapshot — or, while the account shows no assistant
 * (`none` / `loading` / `unreadable`), the snapshot without one (`withoutAssistant`), whatever conversation is chosen, so
 * an App can start the first setup. `unbound`: the account has an assistant and no conversation is chosen yet.
 * `unavailable`: it cannot be told now (the account's assistant could not be verified, or this window has not shown it
 * yet) — try again later. A conversation that is not the person's chat with their own assistant is refused, not an answer.
 */
export type AppAssistantRead = { name: string; state: 'unbound' | 'unavailable' } | { name: string; state: 'ready'; status: AppAssistantStatus };
/** What `onChanged` hears: each new `ready`, and `unbound` once when an assistant appears for an App not pointed at it. */
export type AppAssistantHeard = { name: string; state: 'unbound' } | { name: string; state: 'ready'; status: AppAssistantStatus };

/** The snapshot an App sees while the account shows no assistant: nothing that would name or place one. */
export const withoutAssistant = (status: AppAssistantStatus): AppAssistantStatus => ({ ...status, name: null, avatar: null, home: null });

/** What the window hands main each time the snapshot changes: whose it is (host data, never passed on) and what it is. */
export const pushedAssistantStatusSchema = z.strictObject({ ownerId: z.string().uuid(), status: appAssistantStatusSchema });
export type PushedAssistantStatus = z.infer<typeof pushedAssistantStatusSchema>;
