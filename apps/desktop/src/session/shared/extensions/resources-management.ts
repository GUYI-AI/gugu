import { z } from 'zod';
import type { AppResourceReceipt } from './agent-resources';

/**
 * API 50: what the assistant's own 记忆 pages do to its resources that an App binding could not — each exactly as far as
 * those pages go, through the same store calls (`createAssistantPanelFiles`: `write`, `mkdir`, `rename`, `remove`) and the
 * same host dialogs. Who the owner, agent and chat are stays the host's; the App names the binding, a key it was given and
 * a name. Nothing of a path on disk, an item id, a device or a URL is ever answered.
 *
 * - Why a read failed: a closed `reason` on every `unavailable` (`READ_FAILURE_REASONS`), the classes the assistant's pages
 *   tell the person apart (assistant-panel-errors.ts) — never ids, paths or error text.
 * - 给助理的资料 (`files`, under `resources:write` listing it): `upload` (the host's own file picker, in a click; bytes go
 *   host → store, the App gets the entries made), `createFolder`, `rename`, `removeFolder` (the host asks the person first,
 *   as the assistant's page does).
 * - 语音笔记 (`voice-notes:manage` → `chat:voice-notes:manage`, needs `resources` listing `voice-notes`): `transcribe` a note
 *   uploaded and waiting, `removeVoiceNote` (asked first), `exportVoiceNote` (the host's save dialog). Retrying a note this
 *   computer recorded is API 47's `gugu.voiceNote.retry`.
 * - A draft into the bound conversation may carry files already in its folder or the agent's resources (`attach`), by the
 *   path or key the App holds — never a path of its own.
 */
export const RESOURCES_MANAGEMENT_API_VERSION = 50;

/** The binding action for the voice-note operations, and its capability. */
export const VOICE_NOTES_MANAGE_ACTION = 'voice-notes:manage';
export const VOICE_NOTES_MANAGE_CAPABILITY = 'chat:voice-notes:manage';

/**
 * Why a resource could not be read (or a change could not be made) now — one class per message the assistant's own pages
 * show for it: `stale` its home has not brought it up to date; `not-applied` a change to it failed to apply there;
 * `timed-out` the store did not answer in time; `unreadable` the store or the publication could not be read; `access-unverified`
 * this account's access could not be checked; `owner-unknown` whose assistant it is could not be told; `too-large` past
 * what the store answers at once. `timed-out` and `unreadable` pass by themselves (read again); the others change only
 * when the assistant's home publishes again.
 */
export const READ_FAILURE_REASONS = ['stale', 'not-applied', 'timed-out', 'unreadable', 'access-unverified', 'owner-unknown', 'too-large'] as const;
export type ReadFailureReason = (typeof READ_FAILURE_REASONS)[number];
export type Unavailable = { state: 'unavailable'; reason: ReadFailureReason };

type Named = { name: string };

/** `gugu.bindings.upload(name, { folder? })`: what the person picked, each file one change; refused files by their name. */
export type AppUploadAnswer = Named & (
  | { state: 'unbound' | 'cancelled' }
  | Unavailable
  | {
      state: 'done';
      uploaded: { key: string; name: string; receipt: AppResourceReceipt }[];
      /** `too-large`: past 50 MB; `unsupported`: video, audio or an archive (the assistant reads none); `not-saved`: the store took it not. */
      refused: { name: string; why: 'too-large' | 'unsupported' | 'not-saved' }[];
    }
);

/** `gugu.bindings.createFolder(name, { key })`. `exists`: there already — nothing changed (as the page does). */
export type AppFolderAnswer = Named & { key: string } & ({ state: 'unbound' | 'exists' } | Unavailable | { state: 'committed'; receipt: AppResourceReceipt });

/**
 * `gugu.bindings.rename(name, { key, to })`: a file or a folder (and everything in it) given a new last name. `missing`:
 * nothing at `key`; `exists`: something already has that name.
 */
export type AppRenameAnswer = Named & { key: string } & (
  | { state: 'unbound' | 'missing' | 'exists' }
  | Unavailable
  | { state: 'committed'; renamedTo: string; receipts: AppResourceReceipt[] }
);

/** `gugu.bindings.removeFolder` / `removeVoiceNote`: asked of the person first — `cancelled` when they said no. */
export type AppRemoveAllAnswer = Named & { key: string } & (
  | { state: 'unbound' | 'missing' | 'cancelled' }
  | Unavailable
  | { state: 'committed'; receipts: AppResourceReceipt[] }
);

/**
 * `gugu.bindings.transcribeVoiceNote(name, key)`: a note uploaded from another device and waiting, transcribed by this
 * computer and handed to the agent to sum up — the page's 开始转写. `not-waiting`: it is not waiting (being worked on,
 * done, failed); `busy`: this computer is already at it; `not-ready`: this computer's voice-note host is not ready for
 * this agent yet (try again in a moment).
 */
export type AppTranscribeAnswer = Named & { key: string } & (
  | { state: 'unbound' | 'missing' | 'not-waiting' | 'busy' | 'not-ready' | 'started' }
  | Unavailable
);

/** `gugu.bindings.exportVoiceNote(name, key)`: its summary and transcript as Markdown, where the person saves it. */
export type AppExportAnswer = Named & { key: string } & ({ state: 'unbound' | 'missing' | 'cancelled' | 'saved' } | Unavailable);

/** A file a draft into the bound conversation carries: one of its folder's (`bindings.list`) or of the agent's resources. */
export type DraftAttachment = { file: string } | { domain: 'memory' | 'files' | 'personality' | 'skills' | 'voice-notes'; key: string };
export const DRAFT_ATTACHMENTS_MAX = 9;

const name = z.string().min(1).max(64);
/** One name of a folder or file: what the page's inline name field takes (`folderNameProblem`), at most 255 characters. */
export const entryNameSchema = z.string().trim().min(1).max(255).refine((value) => !value.includes('/'), 'a name has no "/"');
export const uploadArgsSchema = z.strictObject({ name, folder: z.string().max(512).optional() });
export const folderArgsSchema = z.strictObject({ name, key: z.string() });
export const renameArgsSchema = z.strictObject({ name, key: z.string(), to: entryNameSchema });
export const voiceNoteArgsSchema = z.strictObject({ name, key: z.string() });

const DRAFT_DOMAINS = ['memory', 'files', 'personality', 'skills', 'voice-notes'] as const;
const attachmentSchema = z.union([
  z.strictObject({ file: z.string().min(1).max(512) }),
  z.strictObject({ domain: z.enum(DRAFT_DOMAINS), key: z.string().min(1).max(512) }),
]);
/** A binding draft's `attach`, checked: at most nine, each a path of the bound folder or a domain and key of the agent's. */
export function draftAttachmentsOf(value: unknown): DraftAttachment[] {
  const parsed = z.array(attachmentSchema).min(1).max(DRAFT_ATTACHMENTS_MAX).safeParse(value);
  if (!parsed.success) {
    throw Object.assign(new Error(`attach is 1 to ${DRAFT_ATTACHMENTS_MAX} of { file } (a path of the bound conversation's folder, as bindings.list gives it) or { domain, key } (one of the agent's resources)`), { code: 'invalid' as const });
  }
  return parsed.data;
}
