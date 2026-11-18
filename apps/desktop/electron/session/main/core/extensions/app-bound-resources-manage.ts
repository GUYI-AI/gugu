import { z } from 'zod';
import { type AssistantPanelClient, type AssistantPanelItem, type AssistantPanelReceipt } from '@gugu/core/cloud/assistantPanel';
import { readAssistantPanelBody, uploadAssistantPanelBody } from '@gugu/core/cloud/assistantPanelBodies';
import { ASSISTANT_PANEL_PATHS, createAssistantPanelFiles } from '@gugu/core/cloud/assistantPanelFiles';
import { resourceRejection } from '@gugu/core/shared/assistantResourceRules';
import { VOICE_NOTE_META_FILE, VOICE_NOTE_SUMMARY_FILE, VOICE_NOTE_TRANSCRIPT_FILE, VOICE_NOTES_DIR, parseVoiceNoteMeta } from '@gugu/core/shared/voiceNotes';
import { resourceKeyOf, type AppResourceReceipt } from '@shared/extensions/agent-resources';
import {
  RESOURCES_MANAGEMENT_API_VERSION, folderArgsSchema, renameArgsSchema, uploadArgsSchema, voiceNoteArgsSchema,
  type AppExportAnswer, type AppFolderAnswer, type AppRemoveAllAnswer, type AppRenameAnswer, type AppTranscribeAnswer, type AppUploadAnswer,
  type Unavailable,
} from '@shared/extensions/resources-management';
import { account } from './app-unread-bindings';
import { boundAgent, discard, reasonOf, refusedOrUnavailable, storeOf, unavailable, type Bound, type ResourceCallAction } from './app-bound-resources';
import { manageHost } from './app-bound-resources-host';
import { extensionsService } from './extensions-root';

/**
 * #50 (resources-management.ts) What the assistant's own 记忆 pages do to its 给助理的资料 and voice notes, done for an App
 * the person let manage them — by the very functions those pages call on the store (`createAssistantPanelFiles`: `write`,
 * `mkdir`, `rename`, `remove`, `text`), as the person, under the binding's authority (app-bound-resources.ts `boundAgent`:
 * account, grant, domain, selection, the personal assistant — checked again after every wait). The person's own screen
 * does what the page's did there: the host's picker, its question before a delete, its voice-note pipeline, its save
 * dialog (app-bound-resources-host.ts). The App names a key and a name; it hears back keys, names and the store's receipts.
 */

const invalid = (message: string) => Object.assign(new Error(message), { code: 'invalid' });
const denied = (message: string) => Object.assign(new Error(message), { code: 'denied' });
const codeOf = (error: unknown) => (error as { code?: unknown } | null)?.code;
function argsOf<T extends z.ZodType>(schema: T, input: unknown): z.infer<T> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw invalid(`gugu.bindings takes the binding's name and a key or name, never an owner, agent, chat or path on disk (${parsed.error.issues.map((issue) => issue.path.join('.') || issue.message).join(', ')})`);
  return parsed.data;
}

const FILES_ROOT = ASSISTANT_PANEL_PATHS.resourcesDir;
const VOICE_ROOT = `${ASSISTANT_PANEL_PATHS.memoryDir}/${VOICE_NOTES_DIR}`;

/** The store's receipt as an App hears it: nothing more. */
const receiptOf = ({ operationId, revision, status, terminal }: AssistantPanelReceipt): AppResourceReceipt =>
  ({ operationId, revision, status, ...(terminal === undefined ? {} : { terminal }) });

type Panel = { files: ReturnType<typeof createAssistantPanelFiles>; receipts: AssistantPanelReceipt[] };

/** The assistant pages' own store view, as this person, its every commit's receipt kept for the answer. */
function panelOf(bound: Bound): Panel {
  const store = storeOf(bound.ownerId);
  const receipts: AssistantPanelReceipt[] = [];
  const cloud: AssistantPanelClient = {
    ...store,
    commit: async (assistant, change) => {
      const receipt = await store.commit(assistant, change);
      receipts.push(receipt);
      return receipt;
    },
  };
  const access = () => ({ token: bound.token, ownerId: bound.ownerId, chatId: bound.chatId, accountId: async () => (await account().catch(() => null))?.ownerId ?? null });
  const files = createAssistantPanelFiles({
    assistantId: bound.agentId, deviceId: bound.deviceId, ownerId: bound.ownerId, cloud,
    assertCurrent: bound.recheck,
    readBody: (item, signal) => readAssistantPanelBody(item, { ...access(), signal }),
    upload: (label, bytes) => uploadAssistantPanelBody({ ...access(), label, bytes }),
    discard: (itemId) => discard(bound, itemId),
    changed: () => undefined,
  });
  return { files, receipts };
}

/**
 * One managing call under the binding's authority: `unbound` when nobody chose the conversation, `unavailable` with its
 * class when it could not be done now, a refusal thrown. The calls on 给助理的资料 ride on `resources:write`, which an App
 * of API 42 already has: they are an App's of API 50 only.
 */
async function under<T extends object>(
  extensionId: string, name: string, needs: readonly ResourceCallAction[], domain: 'files' | 'voice-notes',
  use: (bound: Bound, panel: Panel) => Promise<T>,
): Promise<T | { name: string; state: 'unbound' } | ({ name: string } & Unavailable)> {
  const manifest = extensionsService().get(extensionId).manifest;
  if (manifest.apiVersion < RESOURCES_MANAGEMENT_API_VERSION) throw denied(`This call needs apiVersion ${RESOURCES_MANAGEMENT_API_VERSION}`);
  const bound = await boundAgent(extensionId, name, needs, domain).catch((error: unknown) => {
    if (codeOf(error) === 'failed') return unavailable(reasonOf(error));
    throw error;
  });
  if (!bound) return { name, state: 'unbound' };
  if ('state' in bound) return { name, ...bound };
  try {
    const value = await use(bound, panelOf(bound));
    await bound.recheck();
    return value;
  } catch (error) {
    // The store's own word for a name it cannot take is the caller's mistake, as for any key.
    if (codeOf(error) === 'invalid-path' || codeOf(error) === '22023') throw invalid('The resource store does not take this name');
    const outcome = refusedOrUnavailable(error);
    await bound.recheck();
    return { name, ...outcome };
  }
}

const WRITE_FILES: readonly ResourceCallAction[] = ['resources', 'resources:write'];
const MANAGE_VOICE: readonly ResourceCallAction[] = ['resources', 'voice-notes:manage'];
const pathOf = (item: AssistantPanelItem) => (typeof item.data.path === 'string' ? item.data.path : item.resource_key);

/** A key of 给助理的资料: a relative path of names (no empty or untrimmed one: what the page's name field takes). */
function filesKeyOf(value: unknown): string {
  return resourceKeyOf('files', value);
}
/** A voice note's key: its id, one name (`resources(name, "voice-notes")` lists it as `noteId`). */
function noteKeyOf(value: unknown): string {
  const key = resourceKeyOf('voice-notes', value);
  if (key.includes('/')) throw invalid('key is a voice note\'s id (its noteId), without "/"');
  return key;
}

/**
 * `gugu.bindings.upload(name, { folder? })` (50, `resources:write` listing `files`, in a click): the host's own picker;
 * each file the page's rules take (50 MB, no video, audio or archive) written as the page writes it — the same name
 * replaces what is there, as the person chose it — the others named back. Cancelled: nothing.
 */
export async function appResourceUpload(extensionId: string, embedderId: number | null, input: unknown): Promise<AppUploadAnswer> {
  const args = argsOf(uploadArgsSchema, input);
  const folder = args.folder ? filesKeyOf(args.folder) : '';
  return under(extensionId, args.name, WRITE_FILES, 'files', async (bound, panel): Promise<AppUploadAnswer> => {
    const picked = await manageHost.pickFiles(embedderId);
    await bound.recheck();
    if (!picked) return { name: args.name, state: 'cancelled' };
    const uploaded: Extract<AppUploadAnswer, { state: 'done' }>['uploaded'] = [];
    const refused: Extract<AppUploadAnswer, { state: 'done' }>['refused'] = [];
    for (const file of picked) {
      const rule = resourceRejection({ name: file.name, size: file.size, type: file.contentType });
      if (rule) { refused.push({ name: file.name, why: rule === 'too_large' ? 'too-large' : 'unsupported' }); continue; }
      const key = folder ? `${folder}/${file.name}` : file.name;
      try {
        filesKeyOf(key);
      } catch {
        refused.push({ name: file.name, why: 'not-saved' });
        continue;
      }
      const before = panel.receipts.length;
      try {
        await panel.files.write(`${FILES_ROOT}/${key}`, await file.read(), file.contentType || 'application/octet-stream');
        const receipt = panel.receipts.slice(before).at(-1);
        if (receipt) uploaded.push({ key, name: file.name, receipt: receiptOf(receipt) });
        else refused.push({ name: file.name, why: 'not-saved' });
      } catch (error) {
        if (codeOf(error) === 'denied') throw error;
        refusedOrUnavailable(error);
        refused.push({ name: file.name, why: 'not-saved' });
      }
      await bound.recheck();
    }
    return { name: args.name, state: 'done', uploaded, refused };
  });
}

/** `gugu.bindings.createFolder(name, key)` (50): a folder made at `key`, as the page's 新建文件夹; already there: `exists`. */
export async function appResourceCreateFolder(extensionId: string, input: unknown): Promise<AppFolderAnswer> {
  const args = argsOf(folderArgsSchema, input);
  const key = filesKeyOf(args.key);
  const answer = await under(extensionId, args.name, WRITE_FILES, 'files', async (_bound, panel): Promise<AppFolderAnswer> => {
    await panel.files.mkdir(`${FILES_ROOT}/${key}`);
    const receipt = panel.receipts.at(-1);
    return receipt ? { name: args.name, key, state: 'committed', receipt: receiptOf(receipt) } : { name: args.name, key, state: 'exists' };
  });
  return 'key' in answer ? answer : { ...answer, key };
}

/**
 * `gugu.bindings.rename(name, key, to)` (50): the file or folder at `key` given the last name `to` — a folder with
 * everything in it — as the page's 重命名. `missing`: nothing there; `exists`: that name is taken.
 */
export async function appResourceRename(extensionId: string, input: unknown): Promise<AppRenameAnswer> {
  const args = argsOf(renameArgsSchema, input);
  const key = filesKeyOf(args.key);
  // One name, as the page's name field takes it (`entryNameSchema`: trimmed, not empty, no "/").
  const to = args.to;
  const renamedTo = [...key.split('/').slice(0, -1), to].join('/');
  filesKeyOf(renamedTo);
  const answer = await under(extensionId, args.name, WRITE_FILES, 'files', async (_bound, panel): Promise<AppRenameAnswer> => {
    const rows = await panel.files.collection('files');
    if (!rows.some((row) => pathOf(row) === key)) return { name: args.name, key, state: 'missing' };
    try {
      await panel.files.rename(`${FILES_ROOT}/${key}`, to);
    } catch (error) {
      if (codeOf(error) === 'exists') return { name: args.name, key, state: 'exists' };
      throw error;
    }
    return { name: args.name, key, state: 'committed', renamedTo, receipts: panel.receipts.map(receiptOf) };
  });
  return 'key' in answer ? answer : { ...answer, key };
}

/**
 * `gugu.bindings.removeFolder(name, key)` (50, in a click): the folder at `key` and everything in it, once the person said
 * yes to the page's own question (删除文件夹？). A file is removed with `bindings.remove`.
 */
export async function appResourceRemoveFolder(extensionId: string, embedderId: number | null, input: unknown): Promise<AppRemoveAllAnswer> {
  const args = argsOf(folderArgsSchema, input);
  const key = filesKeyOf(args.key);
  const answer = await under(extensionId, args.name, WRITE_FILES, 'files', async (bound, panel): Promise<AppRemoveAllAnswer> => {
    const rows = await panel.files.collection('files');
    const self = rows.find((row) => pathOf(row) === key);
    const inside = rows.filter((row) => pathOf(row).startsWith(`${key}/`));
    if (!self && inside.length === 0) return { name: args.name, key, state: 'missing' };
    if (self && self.data.kind !== 'directory' && inside.length === 0) throw invalid('removeFolder removes a folder: a file is removed with bindings.remove');
    const yes = await manageHost.confirmRemoval(embedderId, { kind: 'folder', name: key.split('/').pop()! });
    await bound.recheck();
    if (!yes) return { name: args.name, key, state: 'cancelled' };
    await panel.files.remove(`${FILES_ROOT}/${key}`, true);
    return { name: args.name, key, state: 'committed', receipts: panel.receipts.map(receiptOf) };
  });
  return 'key' in answer ? answer : { ...answer, key };
}

/** The note's own rows (its `note.json`, transcript, summary, audio …), as the page's list reads them: published or not. */
async function noteRows(panel: Panel, id: string): Promise<AssistantPanelItem[]> {
  const snapshot = await panel.files.snapshot();
  return snapshot.items.filter((item) => item.domain === 'voice-notes' && !item.deleted_at && (item.resource_key === id || item.resource_key.startsWith(`${id}/`)));
}
async function noteText(panel: Panel, id: string, file: string): Promise<string | null> {
  return panel.files.text(`${VOICE_ROOT}/${id}/${file}`);
}

/**
 * `gugu.bindings.transcribeVoiceNote(name, key)` (50, `voice-notes:manage`, in a click): a note uploaded from another
 * device and waiting (`status: uploaded`) transcribed by this computer's voice-note pipeline and handed to the agent —
 * the page's 开始转写. Anything else is `not-waiting`; retrying one this computer recorded is API 47's.
 */
export async function appVoiceNoteTranscribe(extensionId: string, embedderId: number | null, input: unknown): Promise<AppTranscribeAnswer> {
  const args = argsOf(voiceNoteArgsSchema, input);
  const key = noteKeyOf(args.key);
  const answer = await under(extensionId, args.name, MANAGE_VOICE, 'voice-notes', async (bound, panel): Promise<AppTranscribeAnswer> => {
    const meta = parseVoiceNoteMeta((await noteText(panel, key, VOICE_NOTE_META_FILE)) ?? '');
    if (!meta) return { name: args.name, key, state: 'missing' };
    if (meta.status !== 'uploaded') return { name: args.name, key, state: 'not-waiting' };
    const outcome = await manageHost.transcribe(embedderId, { ownerId: bound.ownerId, assistantId: bound.agentId, noteId: key });
    await bound.recheck();
    if (outcome === 'denied') throw denied('This window is signed in to another account or has another assistant');
    return { name: args.name, key, state: outcome };
  });
  return 'key' in answer ? answer : { ...answer, key };
}

/** `gugu.bindings.removeVoiceNote(name, key)` (50, in a click): the note and all of it, once the person said yes (删除“…”？). */
export async function appVoiceNoteRemove(extensionId: string, embedderId: number | null, input: unknown): Promise<AppRemoveAllAnswer> {
  const args = argsOf(voiceNoteArgsSchema, input);
  const key = noteKeyOf(args.key);
  const answer = await under(extensionId, args.name, MANAGE_VOICE, 'voice-notes', async (bound, panel): Promise<AppRemoveAllAnswer> => {
    if ((await noteRows(panel, key)).length === 0) return { name: args.name, key, state: 'missing' };
    const title = parseVoiceNoteMeta((await noteText(panel, key, VOICE_NOTE_META_FILE).catch(() => null)) ?? '')?.title ?? null;
    const yes = await manageHost.confirmRemoval(embedderId, { kind: 'voice-note', title, ownerId: bound.ownerId, assistantId: bound.agentId, noteId: key });
    await bound.recheck();
    if (!yes) return { name: args.name, key, state: 'cancelled' };
    await panel.files.remove(`${VOICE_ROOT}/${key}`, true);
    return { name: args.name, key, state: 'committed', receipts: panel.receipts.map(receiptOf) };
  });
  return 'key' in answer ? answer : { ...answer, key };
}

/**
 * `gugu.bindings.exportVoiceNote(name, key)` (50, in a click): its title, summary and transcript as the page's 导出
 * Markdown writes them, where the person saves it in the host's dialog.
 */
export async function appVoiceNoteExport(extensionId: string, embedderId: number | null, input: unknown): Promise<AppExportAnswer> {
  const args = argsOf(voiceNoteArgsSchema, input);
  const key = noteKeyOf(args.key);
  // The save itself failing is the person's disk's, not the store's: said as a failure, past `under`'s read classes.
  let notSaved = false;
  const answer = await under(extensionId, args.name, MANAGE_VOICE, 'voice-notes', async (bound, panel): Promise<AppExportAnswer> => {
    const metaText = await noteText(panel, key, VOICE_NOTE_META_FILE);
    if (metaText === null) return { name: args.name, key, state: 'missing' };
    const [summary, transcript] = await Promise.all([
      noteText(panel, key, VOICE_NOTE_SUMMARY_FILE).catch(() => null),
      noteText(panel, key, VOICE_NOTE_TRANSCRIPT_FILE).catch(() => null),
    ]);
    await bound.recheck();
    const outcome = await manageHost.exportNote(embedderId, { ownerId: bound.ownerId, title: parseVoiceNoteMeta(metaText)?.title ?? null, summary: summary?.trim() ? summary : null, transcript });
    if (outcome === 'denied') throw denied('This window is signed in to another account');
    if (outcome === 'failed') notSaved = true;
    return { name: args.name, key, state: outcome === 'failed' ? 'cancelled' : outcome };
  });
  if (notSaved) throw Object.assign(new Error('The file could not be saved there'), { code: 'failed' });
  return 'key' in answer ? answer : { ...answer, key };
}
