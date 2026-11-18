import { z } from 'zod';

/**
 * #1927 (API 48) What an App placed beside the person's private conversation with their own assistant
 * (`contributes.conversationSurface`, API 41) adds to that conversation's composer 「+」: entries the host draws and the host
 * runs on the person's click, the built-in assistant's 「获取灵感」「录制语音笔记」 and the like. Declared, never scripted: a
 * label, an icon from the host's set, and one `run` from a closed set. No App code runs on that click.
 *
 * - `voice-note`: the host starts a voice note for that assistant, as the built-in entry does (needs `voice-notes:record`).
 * - `draft`: the host puts `text` (in the person's language) at the end of that composer; the person sends it, or not
 *   (needs `draft`).
 * - `page-intent`: the host expands the App's panel (closing any host page over it) and tells the App's page
 *   `intent: { kind: "composer-action", id }` — the entry's own id — once, on `gugu.bindings.onSurface` (the `surface`
 *   action the placement already has). Nothing else comes with it.
 *
 * Only for the person's own assistant chat: on any other conversation the entries are not drawn and a run is refused.
 *
 * `chip` (one entry at most): the entry is also drawn as a capsule at the right end of the row above that composer, with
 * this shorter label, as the built-in 「灵感」 capsule over its 「获取灵感」 entry. A click runs the entry. The capsule gives
 * way to the recording bar while a voice note records, and stays hidden where the person hid the built-in's on this computer.
 */
export const COMPOSER_ACTIONS_API_VERSION = 48;
export const COMPOSER_ACTION_MAX = 6;
export const COMPOSER_ACTION_LABEL_MAX = 40;
export const COMPOSER_ACTION_DRAFT_MAX = 2000;
const NAME = /^[a-z][a-z0-9-]{0,31}$/;

/** The host's icons an entry may name (drawn from the host's own set, as the built-in entries are). */
export const COMPOSER_ACTION_ICONS = ['sparkles', 'mic', 'upload', 'lightbulb', 'pencil', 'heart', 'checklist', 'document', 'book', 'image', 'message'] as const;
export type ComposerActionIcon = (typeof COMPOSER_ACTION_ICONS)[number];

export const COMPOSER_RUN_KINDS = ['voice-note', 'draft', 'page-intent'] as const;
export type ComposerRunKind = (typeof COMPOSER_RUN_KINDS)[number];
/** The binding action each run needs (and so its capability, `BINDING_ACTION_CAPABILITY`). */
export const COMPOSER_RUN_ACTION = { 'voice-note': 'voice-notes:record', draft: 'draft', 'page-intent': 'surface' } as const satisfies Record<ComposerRunKind, string>;

// Control characters, line and paragraph separators, and the bidirectional overrides that would make a label say other
// than it reads.
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;
const UNSAFE_IN_TEXT = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;
const label = z.string().trim().min(1).max(COMPOSER_ACTION_LABEL_MAX).refine((text) => !UNSAFE.test(text), 'a label is one line of plain text');

const draftText = z.string().trim().min(1).max(COMPOSER_ACTION_DRAFT_MAX).refine((text) => !UNSAFE_IN_TEXT.test(text), 'a draft is plain text');

export const composerActionSchema = z.strictObject({
  id: z.string().regex(NAME),
  label: z.strictObject({ zh: label, en: label }),
  icon: z.enum(COMPOSER_ACTION_ICONS),
  chip: z.strictObject({ zh: label, en: label }).optional(),
  run: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('voice-note') }),
    z.strictObject({ kind: z.literal('draft'), text: z.strictObject({ zh: draftText, en: draftText }) }),
    // Told as `intent: { kind: "composer-action", id }` (unread-binding.ts `AppSurfaceIntent`): the entry's id, nothing else.
    z.strictObject({ kind: z.literal('page-intent') }),
  ]),
});
export type ComposerAction = z.infer<typeof composerActionSchema>;

/** What the window drawing the composer is told of an entry: enough to draw it, nothing to run it with. */
export type ComposerActionView = { id: string; label: { zh: string; en: string }; icon: ComposerActionIcon; kind: ComposerRunKind; chip?: { zh: string; en: string } };

/** Trusted window → main: the entries for the column it drew under `authority`, and one of them clicked. */
export const composerActionsAskSchema = z.strictObject({ ownerId: z.string().uuid(), extensionId: z.string().min(1), authority: z.string().uuid() });
export const composerActionRunSchema = composerActionsAskSchema.extend({ actionId: z.string().regex(NAME) }).strict();

/** What main did, or what the window does now (a draft goes into the composer it drew). */
export type ComposerActionResult =
  | { kind: 'voice-note'; outcome: 'started' | 'busy' | 'no_assistant' | 'cancelled' | 'mic_denied' | 'mic_missing' | 'capture_failed' | 'unavailable' }
  | { kind: 'draft'; text: { zh: string; en: string } }
  | { kind: 'page-intent'; delivered: boolean };
