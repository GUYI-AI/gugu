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
 * - `assistant-rename` (`assistant:rename`): in the person's click, renames it, as the built-in name field does.
 * Each action needs `unread` (the binding itself) and its own capability, consented and withdrawn on its own.
 */
export const ASSISTANT_BINDING_ACTIONS = ['assistant-status', 'assistant-open', 'assistant-rename'] as const;
export type AssistantBindingAction = (typeof ASSISTANT_BINDING_ACTIONS)[number];
export const ASSISTANT_BINDING_API_VERSION = 44;

/**
 * The host screens `gugu.assistant.open` opens: the assistant's own pages, drawn over the App's panel
 * (`ASSISTANT_LAYER_SCREENS`); the one close confirmation, its look and model tabs, and the Settings devices section, each
 * by its existing entry (`lib/assistantAppHost.ts`); `health` (API 49) the phone's own health page (its data read on the
 * phone, never handed to the App; a computer answers `unsupported`). A closed list: no other value, and nothing more than
 * the value, is taken. Nothing of the assistant is in Settings (owner 11-06, 11-12: everything about it lives in its App).
 */
export const ASSISTANT_SCREENS = ['setup', 'move', 'close', 'look', 'model', 'devices', 'connected-apps', 'settings', 'projects', 'capabilities', 'health'] as const;
export type AssistantScreen = (typeof ASSISTANT_SCREENS)[number];
/**
 * The assistant's own pages, drawn by the host in the App's panel, over its page, with a back control of its own (the App's
 * host layer, `app-host-layer.tsx`): `setup` the setup guide while there is no assistant yet (from its name on, the App's
 * own intro being the first screen; once there is one, its settings page), `settings` its settings page (资料: who it is,
 * what it uses, where it lives), `move` that same page (its move group is there), `connected-apps` the apps connected to
 * it, `projects` / `capabilities` the built-in panel's 项目 and 能力. The App hears only that a host page is open
 * (`hostPage`), never what it shows.
 */
export const ASSISTANT_LAYER_SCREENS = ['setup', 'settings', 'move', 'connected-apps', 'projects', 'capabilities'] as const satisfies readonly AssistantScreen[];
export type AssistantLayerScreen = (typeof ASSISTANT_LAYER_SCREENS)[number];
export const isAssistantLayerScreen = (screen: string): screen is AssistantLayerScreen => (ASSISTANT_LAYER_SCREENS as readonly string[]).includes(screen);

/** The assistant's name, as the built-in name field takes it (`ASSISTANT_NAME_MAX` in lib/assistantSetup.ts): trimmed. */
export const ASSISTANT_NAME_MAX = 30;
/**
 * What `gugu.assistant.rename(name, text)` answers, a closed set: `renamed`; `unchanged` (the same name); `empty` /
 * `too-long` (trimmed, nothing left / over `ASSISTANT_NAME_MAX`: nothing saved, as the built-in field); `failed` (the save
 * failed: try again).
 */
export const ASSISTANT_RENAME_RESULTS = ['renamed', 'unchanged', 'empty', 'too-long', 'failed'] as const;

export type AssistantRenameResult = (typeof ASSISTANT_RENAME_RESULTS)[number];
/** The built-in field's rule, as main and the window both apply it before anything is saved. */
export function renameCheck(text: string, current: string | null): { result: 'empty' | 'too-long' | 'unchanged' } | { name: string } {
  const name = text.trim();
  if (!name) return { result: 'empty' };
  if (name.length > ASSISTANT_NAME_MAX) return { result: 'too-long' };
  return name === current ? { result: 'unchanged' } : { name };
}

/**
 * Where a page wants the host to draw the assistant's moving figure (`gugu.assistant.figure(name, figure)`, the same
 * `AgentAvatar` the built-in hero and setup guide draw — code, not an image, so it cannot be handed over): its top-left
 * corner in the page's own CSS pixels and its size. The host lays it over the page there, clipped to the page, letting
 * clicks through; the page says it again when its layout moves, and null takes it away. With no assistant yet it is the
 * setup guide's bird.
 */
export const assistantFigureSchema = z.strictObject({
  x: z.number().finite().min(-100_000).max(100_000),
  y: z.number().finite().min(-100_000).max(100_000),
  size: z.number().int().min(16).max(512),
});
export type AssistantFigure = z.infer<typeof assistantFigureSchema>;

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
 * The assistant as the window shows it (`AssistantShellSnapshot`, as an App may see it) — and, with `counts`,
 * `connectors` and `nameMax`, as an App sees it: only what the built-in view already holds and an App needs to draw what
 * it draws — no chat, device or account id, no path, no token.
 * - `assistant`: found / loading / none / unreadable (a failed read, never said as none);
 * - `name`, `avatar`, `tint`: its name, face (`data:` image) and theme hue (its bird's body colour, 0–360; null for a
 *   photo face), null until it is found;
 * - `home`: where it lives (cloud, this computer, another computer, a server), whether it answers there now (a cloud home
 *   that is resting wakes when spoken to: online), and that computer's name as the person named it (`label`, null on the
 *   cloud or unnamed); null until known;
 * - `setup`, `preparing`: the setup step (null: not in setup), and whether its home is being made now (a cloud home made
 *   during setup that is still being made or failed to be: the host's setup shows the progress, the failure and the retry);
 * - `cloudAvailable`: whether a cloud home can be had; `member`: membership, null when not known (never false for that);
 * - `loadError`: the class of the cloud service's last failed read, null when it did not fail;
 * - `ownerName`: what the person is called (the name the ready step greets), null when not set.
 */
export const shownAssistantSchema = z.strictObject({
  assistant: z.enum(['found', 'loading', 'none', 'unreadable']),
  name: z.string().max(NAME_MAX).nullable(),
  avatar: z.string().max(FACE_MAX).regex(FACE).nullable(),
  tint: z.number().finite().min(0).max(360).nullable(),
  home: z.strictObject({
    kind: z.enum(['cloud', 'this-computer', 'other-computer', 'server']),
    online: z.boolean(),
    label: z.string().min(1).max(NAME_MAX).nullable(),
  }).nullable(),
  setup: z.enum(ASSISTANT_SETUP_STEPS).nullable(),
  preparing: z.boolean(),
  cloudAvailable: z.boolean(),
  member: z.boolean().nullable(),
  loadError: z.string().regex(FAILURE_CLASS).nullable(),
  ownerName: z.string().min(1).max(NAME_MAX).nullable(),
});
export type ShownAssistant = z.infer<typeof shownAssistantSchema>;

/**
 * A value read from the assistant's home, as the built-in row reads it: `ready` with it, `loading`, or `unreadable` (the
 * read failed — where the built-in says 「暂时读不到资源」; it reads again by itself).
 */
const readOf = <T extends z.ZodType>(value: T) => z.discriminatedUnion('state', [
  z.strictObject({ state: z.literal('ready'), value }),
  z.strictObject({ state: z.literal('loading') }),
  z.strictObject({ state: z.literal('unreadable') }),
]);
export type AppAssistantReadState<T> = { state: 'ready'; value: T } | { state: 'loading' } | { state: 'unreadable' };

const COUNT_MAX = 1_000_000;
const COUNT = z.number().int().min(0).max(COUNT_MAX);
/**
 * The numbers the built-in panel's rows show, from the same sources (`assistant-app-counts.tsx`), numbers only: `devices`
 * (the shell's `deviceCount`), `connectedApps` (`saved` / `connected`, integrations and chat channels), `projects` (the
 * sidebar's projects), `capabilities` (entries of the user-library `capabilities` volume). Each is a read state.
 */
export const appAssistantCountsSchema = z.strictObject({
  devices: readOf(COUNT),
  connectedApps: readOf(z.strictObject({ saved: COUNT, connected: COUNT })),
  projects: readOf(COUNT),
  capabilities: readOf(COUNT),
});
export type AppAssistantCounts = z.infer<typeof appAssistantCountsSchema>;

/** A connector's mark as the host draws it: its art as an image of its own (`data:`), never a URL elsewhere. */
const ICON = z.string().max(64 * 1024).regex(/^data:image\/(?:svg\+xml|png|webp);base64,[A-Za-z0-9+/=]+$/);
/**
 * One row of the connect step's list (the built-in `ConnectorLists`), in its order: the service (`id`, the catalog's word,
 * what `gugu.assistant.connect` takes), its name, its mark (light, dark — or the light one inverted in dark), and whether
 * it is connected. No account, address or anything of the connection itself.
 */
export const appAssistantConnectorSchema = z.strictObject({
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/),
  name: z.string().min(1).max(NAME_MAX),
  icon: z.strictObject({ light: ICON, dark: ICON.nullable(), invertInDark: z.boolean() }).nullable(),
  connected: z.boolean(),
});
export type AppAssistantConnector = z.infer<typeof appAssistantConnectorSchema>;
const CONNECTORS = z.array(appAssistantConnectorSchema).max(300);

/** A read state as an App may see it: a `ready` value outside the schema is not a value the host has (`unreadable`). */
function readStateOf<T extends z.ZodType>(schema: T, read: AppAssistantReadState<unknown>): AppAssistantReadState<z.infer<T>> {
  if (read.state !== 'ready') return { state: read.state };
  const parsed = schema.safeParse(read.value);
  return parsed.success ? { state: 'ready', value: parsed.data } : { state: 'unreadable' };
}
/** The four numbers as an App may see them. */
export function appAssistantCountsOf(read: Record<keyof AppAssistantCounts, AppAssistantReadState<unknown>>): AppAssistantCounts {
  return {
    devices: readStateOf(COUNT, read.devices),
    connectedApps: readStateOf(z.strictObject({ saved: COUNT, connected: COUNT }), read.connectedApps),
    projects: readStateOf(COUNT, read.projects),
    capabilities: readStateOf(COUNT, read.capabilities),
  };
}
/** The connect step's list as an App may see it. */
export const appAssistantConnectorsOf = (read: AppAssistantReadState<unknown>): AppAssistantReadState<AppAssistantConnector[]> => readStateOf(CONNECTORS, read);

/**
 * With an assistant found: `counts` (the panel's rows), `connectors` (the connect step's list) — null until the panel's
 * reads reach main, and in the snapshot without an assistant — and `nameMax` (the longest name `rename` takes).
 */
export const appAssistantStatusSchema = shownAssistantSchema.extend({
  counts: appAssistantCountsSchema.nullable(),
  connectors: readOf(CONNECTORS).nullable(),
  nameMax: z.literal(ASSISTANT_NAME_MAX),
});
export type AppAssistantStatus = z.infer<typeof appAssistantStatusSchema>;

/**
 * `gugu.assistant.status(name)`. `ready`: the bound assistant's snapshot — or, while the account shows no assistant
 * (`none` / `loading` / `unreadable`), the snapshot without one (`withoutAssistant`), whatever conversation is chosen, so
 * an App can start the first setup. `unbound`: the account has an assistant and no conversation is chosen yet.
 * `unavailable`: it cannot be told now (the account's assistant could not be verified, or this window has not shown it
 * yet) — try again later. A conversation that is not the person's chat with their own assistant is refused, not an answer.
 */
export type AppAssistantRead =
  | { name: string; state: 'unbound' | 'unavailable' }
  | { name: string; state: 'ready'; status: AppAssistantStatus; hostPage: boolean };
/**
 * What `onChanged` hears: each new `ready` (a new snapshot, or a host page opened over the App's panel or closed:
 * `hostPage`), and `unbound` once when an assistant appears for an App not pointed at it.
 */
export type AppAssistantHeard =
  | { name: string; state: 'unbound' }
  | { name: string; state: 'ready'; status: AppAssistantStatus; hostPage: boolean };

/** The snapshot an App sees while the account shows no assistant: nothing that would name, place, colour or count one (the person's own name stays). */
export const withoutAssistant = (status: ShownAssistant): AppAssistantStatus => ({
  ...status, name: null, avatar: null, tint: null, home: null, counts: null, connectors: null, nameMax: ASSISTANT_NAME_MAX,
});

/** What the window hands main each time the snapshot changes: whose it is (host data, never passed on) and what it is. */
export const pushedAssistantStatusSchema = z.strictObject({ ownerId: z.string().uuid(), status: shownAssistantSchema });
export type PushedAssistantStatus = z.infer<typeof pushedAssistantStatusSchema>;
/** The panel's numbers and the connect step's list, as the session page read them for that account (assistant-app-counts.tsx). */
export const pushedAssistantCountsSchema = z.strictObject({ ownerId: z.string().uuid(), counts: appAssistantCountsSchema, connectors: readOf(CONNECTORS) });
export type PushedAssistantCounts = z.infer<typeof pushedAssistantCountsSchema>;
